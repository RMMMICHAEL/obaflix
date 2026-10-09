package com.obaflix.download

import java.net.URI

/**
 * Leitura de playlist HLS, sem rede.
 *
 * Fica separado do downloader de proposito: o que quebra em HLS e a resolucao de
 * URI relativa, a aritmetica de BYTERANGE e a elegibilidade de variante quando o
 * audio vem em faixa separada. As tres coisas sao funcoes puras de texto, e
 * testa-las exige apenas strings.
 */
object HlsPlaylist {

    data class Variante(
        val uri: String,
        val bandwidth: Long,
        val resolucao: String?,
        /** GROUP-ID do atributo AUDIO="…" do #EXT-X-STREAM-INF, quando houver. */
        val grupoAudio: String?,
    )

    /** Intervalo de bytes ja resolvido de um segmento (#EXT-X-BYTERANGE). */
    data class Faixa(val offset: Long, val tamanho: Long) {
        /** `bytes=inicio-fim` para o header HTTP `Range` (fim e inclusivo). */
        fun comoRange(): String = "bytes=$offset-${offset + tamanho - 1}"
    }

    data class Segmento(
        val uri: String,
        /** Faixa de bytes ja resolvida; `null` quando o segmento e o recurso inteiro. */
        val faixa: Faixa?,
    )

    data class Midia(
        val segmentos: List<Segmento>,
        /** #EXT-X-MAP — cabecalho fMP4, precisa vir antes de tudo. */
        val initSegment: Segmento?,
        /**
         * A playlist declara criptografia (#EXT-X-KEY com METHOD diferente de NONE).
         *
         * Baixar isso exigiria gravar a chave de conteudo junto do video. Nao e
         * feito: ver [DownloadFailure.FONTE_INCOMPATIVEL].
         */
        val criptografada: Boolean,
    )

    fun ehMaster(texto: String): Boolean =
        texto.lineSequence().any { it.startsWith("#EXT-X-STREAM-INF") }

    fun ehPlaylist(texto: String): Boolean =
        texto.trimStart().startsWith("#EXTM3U")

    /**
     * Variantes de um master, na ordem em que aparecem.
     *
     * `#EXT-X-STREAM-INF` descreve a variante e a URI vem na **linha seguinte**
     * que nao seja comentario. O atributo `AUDIO="grupo"` liga a variante a um
     * grupo de audio; se esse grupo tiver renditions com URI propria
     * ([gruposAudioExternos]), o audio vem numa faixa separada e a variante nao
     * da para baixar como arquivo unico sem muxar.
     */
    fun parseMaster(texto: String): List<Variante> {
        val linhas = texto.lines()
        val saida = mutableListOf<Variante>()
        var i = 0
        while (i < linhas.size) {
            val linha = linhas[i].trim()
            if (linha.startsWith("#EXT-X-STREAM-INF")) {
                val atributos = atributosDe(linha.substringAfter(':', ""))
                var j = i + 1
                while (j < linhas.size && (linhas[j].isBlank() || linhas[j].startsWith("#"))) j++
                if (j < linhas.size) {
                    saida.add(
                        Variante(
                            uri = linhas[j].trim(),
                            bandwidth = atributos["BANDWIDTH"]?.toLongOrNull() ?: 0L,
                            resolucao = atributos["RESOLUTION"],
                            grupoAudio = atributos["AUDIO"]?.ifBlank { null },
                        )
                    )
                    i = j
                }
            }
            i++
        }
        return saida
    }

    /**
     * GROUP-IDs de audio cujas renditions tem URI propria — ou seja, audio em
     * faixa separada do video.
     *
     * Uma rendition `#EXT-X-MEDIA:TYPE=AUDIO` **sem** URI significa audio embutido
     * no proprio segmento de video (apenas declara o default); so a presenca de
     * URI torna o grupo "externo".
     */
    fun gruposAudioExternos(texto: String): Set<String> {
        val grupos = mutableSetOf<String>()
        for (linha in texto.lines()) {
            val l = linha.trim()
            if (!l.startsWith("#EXT-X-MEDIA:", ignoreCase = true)) continue
            val atributos = atributosDe(l.substringAfter(':', ""))
            if (!atributos["TYPE"].equals("AUDIO", ignoreCase = true)) continue
            val grupo = atributos["GROUP-ID"]?.ifBlank { null } ?: continue
            if (!atributos["URI"].isNullOrBlank()) grupos.add(grupo)
        }
        return grupos
    }

    /** `true` quando a variante toca o audio de um grupo externo (faixa separada). */
    fun temAudioSeparado(variante: Variante, gruposExternos: Set<String>): Boolean =
        variante.grupoAudio != null && variante.grupoAudio in gruposExternos

    /**
     * Variantes baixaveis como arquivo unico (audio embutido), preservando o
     * **indice original** no master — e esse indice que vira o id da qualidade e
     * o que [porId] usa depois para reencontrar a variante na lista completa.
     */
    fun variantesCompativeis(
        variantes: List<Variante>,
        gruposExternos: Set<String>,
    ): List<IndexedValue<Variante>> =
        variantes.withIndex().filter { !temAudioSeparado(it.value, gruposExternos) }

    /**
     * A variante de maior largura de banda.
     *
     * So e usada quando o usuario NAO escolheu qualidade. Recebe ja a lista
     * compativel: cair para uma variante de audio separado aqui entregaria um
     * arquivo mudo em silencio.
     */
    fun melhorVariante(variantes: List<Variante>): Variante? =
        variantes.maxByOrNull { it.bandwidth }

    /**
     * Altura em pixels declarada em `RESOLUTION=LARGURAxALTURA`. Zero quando o
     * atributo nao existe ou nao e parseavel; nunca deduz altura de BANDWIDTH.
     */
    fun alturaDe(resolucao: String?): Int {
        val bruto = resolucao?.trim() ?: return 0
        val x = bruto.indexOf('x', ignoreCase = true)
        if (x <= 0 || x == bruto.length - 1) return 0
        return bruto.substring(x + 1).trim().toIntOrNull()?.takeIf { it > 0 } ?: 0
    }

    /**
     * Identificador estavel de uma variante dentro de um master: a posicao no
     * manifesto completo, nao a resolucao.
     */
    fun idDaVariante(indice: Int): String = "v$indice"

    /** A variante daquele id na lista COMPLETA do master, ou null. */
    fun porId(variantes: List<Variante>, id: String): Variante? {
        val indice = id.removePrefix("v").toIntOrNull() ?: return null
        return variantes.getOrNull(indice)
    }

    /**
     * Segmentos da playlist de midia, com cada #EXT-X-BYTERANGE ja resolvido a
     * um [Faixa] absoluto.
     *
     * Offset implicito: `#EXT-X-BYTERANGE:n` sem `@offset` comeca no byte
     * seguinte ao fim da sub-faixa anterior **do mesmo recurso** (mesma URI).
     * O acumulado e por URI — trocar de URI zera a contagem, senao um segmento
     * herdaria o offset de um recurso diferente e o Range sairia errado.
     */
    fun parseMedia(texto: String): Midia {
        val segmentos = mutableListOf<Segmento>()
        var init: Segmento? = null
        var criptografada = false
        var byteRangePendente: String? = null
        // "uri -> proximo offset implicito" para a aritmetica de BYTERANGE.
        val proximoOffset = HashMap<String, Long>()

        fun resolverFaixa(uri: String, bruto: String?): Faixa? {
            val raw = bruto?.trim()?.ifBlank { null } ?: return null
            val partes = raw.split("@")
            val tamanho = partes.getOrNull(0)?.trim()?.toLongOrNull() ?: return null
            if (tamanho <= 0L) return null
            val offsetExplicito = partes.getOrNull(1)?.trim()?.toLongOrNull()
            val offset = offsetExplicito ?: (proximoOffset[uri] ?: 0L)
            proximoOffset[uri] = offset + tamanho
            return Faixa(offset, tamanho)
        }

        val linhas = texto.lines()
        var i = 0
        while (i < linhas.size) {
            val linha = linhas[i].trim()
            when {
                linha.startsWith("#EXT-X-KEY") -> {
                    val metodo = atributosDe(linha.substringAfter(':', ""))["METHOD"]
                    if (metodo != null && !metodo.equals("NONE", ignoreCase = true)) {
                        criptografada = true
                    }
                }
                linha.startsWith("#EXT-X-MAP") -> {
                    val atributos = atributosDe(linha.substringAfter(':', ""))
                    atributos["URI"]?.let { uri ->
                        init = Segmento(uri, resolverFaixa(uri, atributos["BYTERANGE"]))
                    }
                }
                linha.startsWith("#EXT-X-BYTERANGE") -> {
                    byteRangePendente = linha.substringAfter(':', "").trim().ifBlank { null }
                }
                linha.startsWith("#EXTINF") -> {
                    // A URI e a proxima linha nao-comentario. Entre as duas pode
                    // haver #EXT-X-BYTERANGE, ja tratado acima.
                    var j = i + 1
                    while (j < linhas.size) {
                        val candidata = linhas[j].trim()
                        if (candidata.startsWith("#EXT-X-BYTERANGE")) {
                            byteRangePendente = candidata.substringAfter(':', "").trim().ifBlank { null }
                            j++
                            continue
                        }
                        if (candidata.isBlank() || candidata.startsWith("#")) {
                            j++
                            continue
                        }
                        segmentos.add(Segmento(candidata, resolverFaixa(candidata, byteRangePendente)))
                        byteRangePendente = null
                        break
                    }
                    i = j
                }
            }
            i++
        }
        return Midia(segmentos, init, criptografada)
    }

    /**
     * Resolve uma URI de playlist contra a URL de onde ela veio (RFC 3986),
     * cobrindo absoluta, enraizada e relativa.
     */
    fun resolver(base: String, referencia: String): String = runCatching {
        URI(base).resolve(referencia).toString()
    }.getOrElse { referencia }

    /**
     * Atributos `CHAVE=valor` separados por virgula, com aspas opcionais.
     * Virgula dentro de aspas nao separa.
     */
    internal fun atributosDe(texto: String): Map<String, String> {
        val mapa = LinkedHashMap<String, String>()
        val atual = StringBuilder()
        var dentroDeAspas = false
        val partes = mutableListOf<String>()
        for (c in texto) {
            when {
                c == '"' -> {
                    dentroDeAspas = !dentroDeAspas
                    atual.append(c)
                }
                c == ',' && !dentroDeAspas -> {
                    partes.add(atual.toString())
                    atual.setLength(0)
                }
                else -> atual.append(c)
            }
        }
        if (atual.isNotEmpty()) partes.add(atual.toString())

        for (parte in partes) {
            val igual = parte.indexOf('=')
            if (igual <= 0) continue
            val chave = parte.substring(0, igual).trim()
            val valor = parte.substring(igual + 1).trim().removeSurrounding("\"")
            if (chave.isNotEmpty()) mapa[chave] = valor
        }
        return mapa
    }
}
