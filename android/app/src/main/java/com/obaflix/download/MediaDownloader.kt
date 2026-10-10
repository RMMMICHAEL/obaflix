package com.obaflix.download

import android.content.ContentResolver
import androidx.documentfile.provider.DocumentFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.Buffer
import okio.ByteString.Companion.decodeHex
import okio.Options
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.URL
import java.util.concurrent.TimeUnit

/** Avanco de um download em andamento. Chamado de dentro do laco de escrita. */
interface ProgressoSink {
    fun avancou(bytes: Long, bytesTotal: Long, segmentosFeitos: Int, segmentosTotal: Int)
}

/** O que sobrou quando o download terminou bem. */
data class ResultadoDownload(
    val saidaUri: String,
    val bytes: Long,
    val segmentos: Int,
)

class DownloadException(val motivo: DownloadFailure, mensagem: String) : Exception(mensagem)

/**
 * Busca a midia e grava dentro da arvore SAF escolhida.
 *
 * ## Headers
 *
 * Manda exatamente `Referer` e `User-Agent` — os mesmos dois que o
 * `PlayerWebViewClient` injeta quando a WebView busca a mesma midia. Nenhum
 * cookie sai daqui: o `OkHttpClient` nao tem CookieJar.
 *
 * ## HLS vira UM arquivo
 *
 * O HLS nao e gravado como pasta de segmentos + manifesto (o que a 1.0.17 fazia
 * e o que o smoke reprovou). Os segmentos sao concatenados num unico arquivo —
 * TS cru vira `.ts`, fMP4 (init do EXT-X-MAP + fragmentos) vira `.mp4`. A
 * montagem e a finalizacao vivem em [HlsAssembler], puras e testaveis; aqui
 * ficam a rede (OkHttp) e o armazenamento (SAF).
 */
class MediaDownloader(
    private val contentResolver: ContentResolver,
    private val client: OkHttpClient = clientPadrao(),
) {

    companion object {
        private const val BUFFER = 64 * 1024
        private const val TENTATIVAS = 3
        internal const val MAX_MANIFEST_BYTES = 4L * 1024 * 1024
        private val MANIFEST_BOMS = Options.of(
            "efbbbf".decodeHex(), "feff".decodeHex(), "fffe0000".decodeHex(),
            "fffe".decodeHex(), "0000feff".decodeHex(),
        )

        /** O corpo entregue pelo OkHttp já passou pela descompressão transparente. */
        internal suspend fun lerManifesto(client: OkHttpClient, request: Request): String {
            var tentativa = 0
            while (true) {
                currentCoroutineContext().ensureActive()
                val call = client.newCall(request)
                try {
                    call.execute().use { response ->
                        try {
                            if (!response.isSuccessful) {
                                throw DownloadException(
                                    if (response.code == 401 || response.code == 403)
                                        DownloadFailure.FONTE_EXPIRADA else DownloadFailure.HTTP,
                                    "HTTP ${response.code}",
                                )
                            }
                            val body = response.body ?: throw DownloadException(
                                DownloadFailure.MANIFESTO_INVALIDO, "Manifesto vazio",
                            )
                            val input = body.source()
                            val buffer = Buffer()
                            var lidos = 0L
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val restante = MAX_MANIFEST_BYTES - lidos
                                if (restante == 0L) {
                                    // Sonda somente um byte; nunca acumula além do teto.
                                    val excedente = Buffer()
                                    if (input.read(excedente, 1) != -1L) {
                                        throw DownloadException(
                                            DownloadFailure.MANIFESTO_INVALIDO, "Manifesto acima do limite",
                                        )
                                    }
                                    break
                                }
                                val n = input.read(buffer, minOf(8192L, restante))
                                if (n == -1L) break
                                lidos += n
                            }
                            currentCoroutineContext().ensureActive()
                            val charset = when (buffer.select(MANIFEST_BOMS)) {
                                0 -> Charsets.UTF_8
                                1 -> Charsets.UTF_16BE
                                2 -> java.nio.charset.Charset.forName("UTF-32LE")
                                3 -> Charsets.UTF_16LE
                                4 -> java.nio.charset.Charset.forName("UTF-32BE")
                                else -> body.contentType()?.charset(Charsets.UTF_8) ?: Charsets.UTF_8
                            }
                            return buffer.readString(charset)
                        } catch (error: Throwable) {
                            // Cancela antes de close: não drena uma resposta rejeitada.
                            call.cancel()
                            throw error
                        }
                    }
                } catch (error: DownloadException) {
                    throw error
                } catch (error: IOException) {
                    call.cancel()
                    currentCoroutineContext().ensureActive()
                    tentativa++
                    if (tentativa >= TENTATIVAS) {
                        throw DownloadException(DownloadFailure.REDE, error.message ?: "Falha de rede")
                    }
                }
            }
        }

        fun clientPadrao(): OkHttpClient = OkHttpClient.Builder()
            // Sem cookieJar de proposito — ver o KDoc da classe.
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()

        /**
         * Recusa destino que nao seja publico. Mesma checagem do StreamExtractor:
         * a URL vem de terceiro e um redirect para 127.0.0.1 ou rede local
         * transformaria o download num SSRF com o aparelho como pivo.
         */
        fun destinoPublico(url: String): Boolean = runCatching {
            val parsed = URL(url)
            if (parsed.protocol != "https") return false
            val enderecos = InetAddress.getAllByName(parsed.host)
            enderecos.isNotEmpty() && enderecos.none {
                it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress ||
                    it.isSiteLocalAddress || it.isMulticastAddress
            }
        }.getOrDefault(false)

        /**
         * Monta o pedido HTTP: sempre Referer e User-Agent (os mesmos que a
         * WebView injeta), e o Range do HLS (BYTERANGE) ou da retomada do MP4.
         * No companion para ser testavel sem rede.
         */
        internal fun pedido(source: DownloadSource, url: String, faixaDe: Long = 0L, rangeHls: String? = null): Request =
            Request.Builder().url(url).apply {
                source.referer?.let { header("Referer", it) }
                source.userAgent?.let { header("User-Agent", it) }
                when {
                    rangeHls != null -> header("Range", rangeHls)
                    faixaDe > 0L -> header("Range", "bytes=$faixaDe-")
                }
            }.build()
    }

    // -- Sondagem de qualidades ----------------------------------------------

    /**
     * Quais resolucoes esta fonte oferece — e, no caminho HLS, se ela da para
     * baixar como arquivo unico.
     *
     * HLS: le o manifesto; master → variantes, filtrando as que tocam audio em
     * faixa separada (so sobra o que concatena sozinho). Se nenhuma variante
     * compativel sobrar, ou a midia direta vier criptografada, lanca
     * [DownloadFailure.FONTE_INCOMPATIVEL] e o lado web tenta a proxima fonte.
     */
    suspend fun sondarQualidades(source: DownloadSource): List<QualidadeDownload> =
        withContext(Dispatchers.IO) {
            if (source.kind == MediaKind.MP4) return@withContext listOf(QualidadeDownload.padrao())

            exigirDestinoPublico(source.url)
            val texto = baixarTexto(source, source.url)
            if (!HlsPlaylist.ehPlaylist(texto)) {
                throw DownloadException(DownloadFailure.MANIFESTO_INVALIDO, "Resposta nao e um manifesto HLS")
            }

            if (!HlsPlaylist.ehMaster(texto)) {
                // Playlist de midia direta: so recusa se vier criptografada.
                if (HlsPlaylist.parseMedia(texto).criptografada) {
                    throw DownloadException(DownloadFailure.FONTE_INCOMPATIVEL, "HLS criptografado")
                }
                return@withContext listOf(QualidadeDownload.padrao())
            }

            val variantes = HlsPlaylist.parseMaster(texto)
            val externos = HlsPlaylist.gruposAudioExternos(texto)
            val compativeis = HlsPlaylist.variantesCompativeis(variantes, externos)
            if (compativeis.isEmpty()) {
                throw DownloadException(DownloadFailure.FONTE_INCOMPATIVEL, "HLS com audio em faixa separada")
            }
            QualidadeDownload.deVariantes(compativeis, source.url)
        }

    // -- MP4 ------------------------------------------------------------------

    suspend fun baixarMp4(
        source: DownloadSource,
        pasta: DocumentFile,
        nomeArquivo: String,
        sink: ProgressoSink,
    ): ResultadoDownload = withContext(Dispatchers.IO) {
        exigirDestinoPublico(source.url)

        val arquivo = pasta.createFile("video/mp4", nomeArquivo)
            ?: throw DownloadException(DownloadFailure.ESCRITA, "Nao foi possivel criar o arquivo")

        var gravados = 0L
        var total = -1L
        var tentativa = 0

        while (true) {
            currentCoroutineContext().ensureActive()
            try {
                val modo = if (gravados > 0L) "wa" else "w"
                val resposta = executar(source, source.url, faixaDe = gravados)
                resposta.use { r ->
                    val corpo = r.body ?: throw DownloadException(DownloadFailure.HTTP, "Resposta sem corpo")
                    if (total < 0L) {
                        val declarado = corpo.contentLength()
                        if (declarado > 0L) total = declarado + gravados
                    }
                    contentResolver.openOutputStream(arquivo.uri, modo).use { saida ->
                        if (saida == null) {
                            throw DownloadException(DownloadFailure.ESCRITA, "Sem stream de escrita")
                        }
                        gravados += copiar(corpo.byteStream(), { buf, n -> saida.write(buf, 0, n) }) { parcial ->
                            sink.avancou(gravados + parcial, total, 0, 0)
                        }
                    }
                }
                break
            } catch (e: DownloadException) {
                throw e
            } catch (e: IOException) {
                tentativa++
                if (tentativa >= TENTATIVAS) {
                    throw DownloadException(DownloadFailure.REDE, e.message ?: "Falha de rede")
                }
            }
        }

        ResultadoDownload(arquivo.uri.toString(), gravados, 0)
    }

    // -- HLS: concatena num arquivo unico -------------------------------------

    /**
     * Resolve master→variante (quando houver) e concatena init + segmentos num
     * unico arquivo via [HlsAssembler]. A variante do usuario e respeitada: se a
     * URL guardada ainda for um master, `varianteId` decide — nunca cai para a
     * melhor variante em silencio quando alguem escolheu outra.
     */
    suspend fun baixarHls(
        source: DownloadSource,
        pasta: DocumentFile,
        titulo: String,
        sink: ProgressoSink,
        varianteId: String? = null,
    ): ResultadoDownload = withContext(Dispatchers.IO) {
        exigirDestinoPublico(source.url)

        val textoInicial = baixarTexto(source, source.url)
        if (!HlsPlaylist.ehPlaylist(textoInicial)) {
            throw DownloadException(DownloadFailure.MANIFESTO_INVALIDO, "Resposta nao e um manifesto HLS")
        }

        var urlDaMidia = source.url
        var textoDaMidia = textoInicial
        if (HlsPlaylist.ehMaster(textoInicial)) {
            val variantes = HlsPlaylist.parseMaster(textoInicial)
            val externos = HlsPlaylist.gruposAudioExternos(textoInicial)
            val compativeis = HlsPlaylist.variantesCompativeis(variantes, externos)
            if (compativeis.isEmpty()) {
                throw DownloadException(DownloadFailure.FONTE_INCOMPATIVEL, "HLS com audio em faixa separada")
            }
            val variante = if (varianteId != null && varianteId != QualidadeDownload.ID_PADRAO) {
                val escolhida = HlsPlaylist.porId(variantes, varianteId)
                    ?: throw DownloadException(DownloadFailure.FONTE_INCOMPATIVEL, "Variante escolhida nao existe mais")
                if (HlsPlaylist.temAudioSeparado(escolhida, externos)) {
                    throw DownloadException(DownloadFailure.FONTE_INCOMPATIVEL, "Variante usa audio separado")
                }
                escolhida
            } else {
                HlsPlaylist.melhorVariante(compativeis.map { it.value })
                    ?: throw DownloadException(DownloadFailure.MANIFESTO_INVALIDO, "Master sem variantes")
            }
            urlDaMidia = HlsPlaylist.resolver(source.url, variante.uri)
            exigirDestinoPublico(urlDaMidia)
            textoDaMidia = baixarTexto(source, urlDaMidia)
        }

        val midia = HlsPlaylist.parseMedia(textoDaMidia)
        if (midia.criptografada) {
            throw DownloadException(DownloadFailure.FONTE_INCOMPATIVEL, "HLS criptografado")
        }
        if (midia.segmentos.isEmpty()) {
            throw DownloadException(DownloadFailure.MANIFESTO_INVALIDO, "Playlist sem segmentos")
        }

        val feitosTotal = (if (midia.initSegment != null) 1 else 0) + midia.segmentos.size
        val parcial = SafArquivoParcial(pasta, DownloadFolder.nomeSeguro(titulo, "part"))

        val (container, bytes) = try {
            HlsAssembler.montar(
                midia = midia,
                urlDaMidia = urlDaMidia,
                baixar = { url, faixa -> baixarBytes(source, url, faixa) },
                destinoPublico = { destinoPublico(it) },
                parcial = parcial,
            ) { b, feitos, total -> sink.avancou(b, -1L, feitos, total) }
        } catch (e: Throwable) {
            // Cancelamento, falha de rede, container desconhecido: nunca deixa .part.
            parcial.descartar()
            throw e
        }

        val uri = try {
            HlsAssembler.finalizar(parcial, DownloadFolder.nomeSeguro(titulo, container.extensao()), container)
        } catch (e: Throwable) {
            parcial.descartar()
            throw e
        }

        ResultadoDownload(uri, bytes, feitosTotal)
    }

    /**
     * O arquivo `.part` sobre SAF e sua finalizacao. renameTo nao e universal
     * entre provedores de documentos; por isso o fallback de copia.
     */
    private inner class SafArquivoParcial(
        private val pasta: DocumentFile,
        nomeParte: String,
    ) : ArquivoParcial {
        private val parte: DocumentFile = pasta.createFile("application/octet-stream", nomeParte)
            ?: throw DownloadException(DownloadFailure.ESCRITA, "Nao foi possivel criar o arquivo temporario")
        private var saida: OutputStream? = contentResolver.openOutputStream(parte.uri, "w")
            ?: throw DownloadException(DownloadFailure.ESCRITA, "Sem stream de escrita")

        override fun escrever(bytes: ByteArray) {
            (saida ?: throw DownloadException(DownloadFailure.ESCRITA, "Stream de escrita fechado")).write(bytes)
        }

        private fun fecharStream() {
            runCatching { saida?.flush(); saida?.close() }
            saida = null
        }

        override fun renomearPara(nomeFinal: String): String? {
            fecharStream()
            val ok = runCatching { parte.renameTo(nomeFinal) }.getOrDefault(false)
            return if (ok) parte.uri.toString() else null
        }

        override fun copiarParaFinal(nomeFinal: String, mime: String): String {
            fecharStream()
            val finalDoc = pasta.createFile(mime, nomeFinal)
                ?: throw DownloadException(DownloadFailure.ESCRITA, "Nao foi possivel criar o arquivo final")
            try {
                val copiados = contentResolver.openInputStream(parte.uri).use { entrada ->
                    contentResolver.openOutputStream(finalDoc.uri, "w").use { saidaFinal ->
                        if (entrada == null || saidaFinal == null) {
                            throw DownloadException(DownloadFailure.ESCRITA, "Sem stream para copiar")
                        }
                        entrada.copyTo(saidaFinal, BUFFER)
                    }
                }
                if (copiados <= 0L) throw DownloadException(DownloadFailure.ESCRITA, "Copia vazia")
            } catch (e: Throwable) {
                // Finalizacao falhou: apaga o final incompleto e o .part. Nada
                // parcial fica visivel, e o download nao vira CONCLUIDO.
                runCatching { finalDoc.delete() }
                runCatching { parte.delete() }
                if (e is DownloadException) throw e
                throw DownloadException(DownloadFailure.ESCRITA, e.message ?: "Falha ao finalizar")
            }
            runCatching { parte.delete() }
            return finalDoc.uri.toString()
        }

        override fun descartar() {
            fecharStream()
            runCatching { parte.delete() }
        }
    }

    // -- Comuns ---------------------------------------------------------------

    private fun exigirDestinoPublico(url: String) {
        if (!destinoPublico(url)) {
            throw DownloadException(DownloadFailure.FONTE_INCOMPATIVEL, "Destino bloqueado")
        }
    }

    private fun executar(source: DownloadSource, url: String, faixaDe: Long = 0L, rangeHls: String? = null) =
        client.newCall(pedido(source, url, faixaDe, rangeHls)).execute().also { r ->
            if (!r.isSuccessful) {
                val codigo = r.code
                r.close()
                throw DownloadException(
                    if (codigo == 403 || codigo == 401) DownloadFailure.FONTE_EXPIRADA else DownloadFailure.HTTP,
                    "HTTP $codigo",
                )
            }
        }

    private suspend fun baixarTexto(source: DownloadSource, url: String): String {
        return lerManifesto(client, pedido(source, url))
    }

    /** Bytes de um segmento (ou do init), com a faixa de BYTERANGE quando houver. */
    private suspend fun baixarBytes(source: DownloadSource, url: String, faixa: HlsPlaylist.Faixa?): ByteArray {
        var tentativa = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            try {
                executar(source, url, rangeHls = faixa?.comoRange()).use { r ->
                    return r.body?.bytes()
                        ?: throw DownloadException(DownloadFailure.HTTP, "Segmento sem corpo")
                }
            } catch (e: DownloadException) {
                throw e
            } catch (e: IOException) {
                tentativa++
                if (tentativa >= TENTATIVAS) {
                    throw DownloadException(DownloadFailure.REDE, e.message ?: "Falha de rede")
                }
            }
        }
    }

    private suspend fun copiar(
        entrada: InputStream,
        escrever: (ByteArray, Int) -> Unit,
        aoAvancar: ((Long) -> Unit)?,
    ): Long {
        val buffer = ByteArray(BUFFER)
        var total = 0L
        entrada.use { fonte ->
            while (true) {
                currentCoroutineContext().ensureActive()
                val lidos = fonte.read(buffer)
                if (lidos <= 0) break
                escrever(buffer, lidos)
                total += lidos
                aoAvancar?.invoke(total)
            }
        }
        return total
    }
}
