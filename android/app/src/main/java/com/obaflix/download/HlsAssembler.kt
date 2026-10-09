package com.obaflix.download

/**
 * Monta um HLS baixado num ÚNICO arquivo, sem transcodificar — a mesma decisão
 * do Electron (`desktop/electron/media-download.js`):
 *
 *   - **MPEG-TS**: segmentos crus concatenados na ordem = `.ts` válido;
 *   - **fMP4**: init do #EXT-X-MAP (uma única vez) + fragmentos na ordem = `.mp4`
 *     fragmentado válido.
 *
 * Puro e sem Android de propósito: a rede e o armazenamento SAF entram por
 * interfaces injetadas, então a concatenação, a identificação de container e a
 * finalização (rename/cópia) são testáveis só com `java.io`.
 */

/** Container identificado pelos bytes — nunca pela extensão da URL nem pelo Content-Type. */
enum class Container {
    FMP4,
    TS,
    DESCONHECIDO;

    fun extensao(): String = when (this) {
        FMP4 -> "mp4"
        TS -> "ts"
        DESCONHECIDO -> "bin"
    }

    fun mime(): String = when (this) {
        FMP4 -> "video/mp4"
        TS -> "video/mp2t"
        DESCONHECIDO -> "application/octet-stream"
    }
}

/** Baixa os bytes de um recurso, com faixa opcional (BYTERANGE). Lança em falha. */
fun interface BaixarBytes {
    suspend fun baixar(url: String, faixa: HlsPlaylist.Faixa?): ByteArray
}

/**
 * O arquivo temporário `.part` e como finalizá-lo. SAF-dependente na produção,
 * fake nos testes.
 */
interface ArquivoParcial {
    /** Escreve o próximo pedaço no `.part`, em ordem. */
    fun escrever(bytes: ByteArray)

    /**
     * Tenta `DocumentFile.renameTo` para o nome final. Devolve a URI final, ou
     * `null` quando o provider SAF não suporta renomear (aí entra a cópia).
     */
    fun renomearPara(nomeFinal: String): String?

    /**
     * Fallback: cria o arquivo final com `mime`, copia o `.part` INTEIRO, valida
     * a escrita e apaga o `.part`. Em qualquer falha, apaga o final incompleto e
     * lança — nunca deixa um arquivo final pela metade visível.
     */
    fun copiarParaFinal(nomeFinal: String, mime: String): String

    /** Apaga o `.part`. Idempotente. Usado em cancelamento/falha. */
    fun descartar()
}

object HlsAssembler {

    private val CAIXAS_FMP4 = setOf("ftyp", "styp", "moof", "sidx", "moov")

    /** fMP4 pela caixa em bytes 4..7; MPEG-TS pelo sync byte 0x47 no início. */
    fun identificarContainer(prefixo: ByteArray): Container {
        if (prefixo.size >= 8) {
            val caixa = String(prefixo, 4, 4, Charsets.US_ASCII)
            if (caixa in CAIXAS_FMP4) return Container.FMP4
        }
        if (prefixo.isNotEmpty() && prefixo[0] == 0x47.toByte()) return Container.TS
        return Container.DESCONHECIDO
    }

    /**
     * Baixa init (se houver) + segmentos na ordem, escrevendo cada pedaço no
     * `.part`. Identifica o container pelo PRIMEIRO pedaço e exige que ele seja
     * reconhecível; não mistura containers. Devolve o container e o total de bytes.
     *
     * `destinoPublico` é aplicado a CADA URL resolvida (init e segmentos), não só
     * à playlist — um segmento redirecionando para loopback/rede privada seria
     * SSRF. `baixar`/`escrever` lançam em erro e o chamador limpa o `.part`.
     */
    suspend fun montar(
        midia: HlsPlaylist.Midia,
        urlDaMidia: String,
        baixar: BaixarBytes,
        destinoPublico: (String) -> Boolean,
        parcial: ArquivoParcial,
        aoAvancar: (bytes: Long, feitos: Int, total: Int) -> Unit = { _, _, _ -> },
    ): Pair<Container, Long> {
        val partes = buildList {
            midia.initSegment?.let { add(it) }
            addAll(midia.segmentos)
        }
        if (partes.isEmpty()) {
            throw DownloadException(DownloadFailure.MANIFESTO_INVALIDO, "Playlist sem segmentos")
        }

        val total = partes.size
        var container = Container.DESCONHECIDO
        var bytes = 0L
        var feitos = 0

        for (parte in partes) {
            val url = HlsPlaylist.resolver(urlDaMidia, parte.uri)
            if (!destinoPublico(url)) {
                throw DownloadException(DownloadFailure.FONTE_INCOMPATIVEL, "Destino bloqueado")
            }
            val dados = baixar.baixar(url, parte.faixa)
            if (container == Container.DESCONHECIDO) {
                container = identificarContainer(dados)
                if (container == Container.DESCONHECIDO) {
                    throw DownloadException(DownloadFailure.FONTE_INCOMPATIVEL, "Container não identificado")
                }
            }
            parcial.escrever(dados)
            bytes += dados.size
            feitos++
            aoAvancar(bytes, feitos, total)
        }
        return container to bytes
    }

    /**
     * Finaliza o `.part`: tenta renomear; se o provider SAF não suportar, cai na
     * cópia completa. Lança (sem deixar arquivo final parcial) se nada funcionar.
     */
    fun finalizar(parcial: ArquivoParcial, nomeFinal: String, container: Container): String =
        parcial.renomearPara(nomeFinal) ?: parcial.copiarParaFinal(nomeFinal, container.mime())
}
