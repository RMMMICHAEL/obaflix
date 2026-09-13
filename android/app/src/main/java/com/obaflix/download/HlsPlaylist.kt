package com.obaflix.download

import java.net.URI

/**
 * Leitura e reescrita de playlist HLS, sem rede.
 *
 * Fica separado do downloader de proposito: o que quebra em HLS e a resolucao
 * de URI relativa e a reescrita do manifesto local, e as duas coisas sao
 * funcoes puras de texto. Testa-las exige apenas strings.
 */
object HlsPlaylist {

    data class Variante(
        val uri: String,
        val bandwidth: Long,
        val resolucao: String?,
    )

    data class Segmento(
        val uri: String,
        /** "tamanho@offset" do #EXT-X-BYTERANGE, quando houver. */
        val byteRange: String?,
    )

    data class Midia(
        val segmentos: List<Segmento>,
        /** #EXT-X-MAP — cabecalho fMP4, precisa vir antes de tudo. */
        val initSegment: Segmento?,
        /**
         * A playlist declara criptografia (#EXT-X-KEY com METHOD diferente de NONE).
         *
         * Baixar isso exigiria gravar a chave de conteudo junto do video na
         * pasta do usuario. Nao e feito: ver [DownloadFailure.MANIFESTO_INVALIDO]
         * e a secao de limites conhecidos.
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
     * que nao seja comentario — nao no mesmo atributo. Linhas em branco entre
     * as duas sao validas e aparecem em manifesto de CDN real.
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
     * A variante de maior largura de banda.
     *
     * So e usada quando o usuario NAO escolheu qualidade — ou seja, quando a
     * fonte oferece uma opcao unica ("Padrao") porque o manifesto nao declara
     * resolucao. Depois que alguem escolheu 480p, quem manda e [porId]; cair
     * aqui de volta entregaria 1080p a quem pediu 480p.
     */
    fun melhorVariante(variantes: List<Variante>): Variante? =
        variantes.maxByOrNull { it.bandwidth }

    /**
     * Altura em pixels declarada em `RESOLUTION=LARGURAxALTURA`.
     *
     * Zero quando o atributo nao existe ou nao e parseavel. Nunca deduz altura
     * a partir de BANDWIDTH: a relacao entre taxa de bits e resolucao varia por
     * codec e por encoder, e chutar "2.4 Mbps deve ser 720p" e exatamente o
     * tipo de rotulo inventado que a interface nao pode mostrar.
     */
    fun alturaDe(resolucao: String?): Int {
        val bruto = resolucao?.trim() ?: return 0
        val x = bruto.indexOf('x', ignoreCase = true)
        if (x <= 0 || x == bruto.length - 1) return 0
        return bruto.substring(x + 1).trim().toIntOrNull()?.takeIf { it > 0 } ?: 0
    }

    /**
     * Identificador estavel de uma variante dentro de um master.
     *
     * E a posicao no manifesto, nao a resolucao: dois renditions podem declarar
     * a mesma RESOLUTION (audio diferente, codec diferente) e um id por
     * resolucao escolheria o errado.
     */
    fun idDaVariante(indice: Int): String = "v$indice"

    /** A variante daquele id, ou null se o id nao pertence a este master. */
    fun porId(variantes: List<Variante>, id: String): Variante? {
        val indice = id.removePrefix("v").toIntOrNull() ?: return null
        return variantes.getOrNull(indice)
    }

    fun parseMedia(texto: String): Midia {
        val segmentos = mutableListOf<Segmento>()
        var init: Segmento? = null
        var criptografada = false
        var byteRangePendente: String? = null

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
                    atributos["URI"]?.let { init = Segmento(it, atributos["BYTERANGE"]) }
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
                        segmentos.add(Segmento(candidata, byteRangePendente))
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
     * Resolve uma URI de playlist contra a URL de onde ela veio.
     *
     * Manifesto de CDN mistura os tres casos no mesmo arquivo: absoluta
     * (`https://...`), enraizada (`/hls/x.ts`) e relativa (`../seg/x.ts`).
     * `URI.resolve` cobre os tres com as regras do RFC 3986 — reimplementar
     * isso a mao e onde nasce o "404 so em alguns titulos".
     */
    fun resolver(base: String, referencia: String): String = runCatching {
        URI(base).resolve(referencia).toString()
    }.getOrElse { referencia }

    /**
     * Reescreve a playlist para apontar aos arquivos locais.
     *
     * [nomeLocal] recebe a URI original de cada segmento (ja resolvida) e
     * devolve o nome do arquivo gravado ao lado do manifesto.
     *
     * `#EXT-X-BYTERANGE` sai do resultado: cada segmento virou um arquivo
     * proprio com exatamente aqueles bytes, entao um intervalo remanescente
     * faria o player ler o pedaco errado do arquivo local.
     */
    fun reescreverParaLocal(
        texto: String,
        base: String,
        nomeLocal: (String) -> String?,
    ): String {
        val saida = StringBuilder(texto.length)
        for (linhaBruta in texto.lines()) {
            val linha = linhaBruta.trim()
            when {
                linha.startsWith("#EXT-X-BYTERANGE") -> continue

                linha.startsWith("#EXT-X-MAP") -> {
                    val atributos = atributosDe(linha.substringAfter(':', ""))
                    val uri = atributos["URI"]
                    val local = uri?.let { nomeLocal(resolver(base, it)) }
                    if (local != null) {
                        saida.append("#EXT-X-MAP:URI=\"").append(local).append("\"")
                    } else {
                        saida.append(linhaBruta)
                    }
                }

                linha.isBlank() || linha.startsWith("#") -> saida.append(linhaBruta)

                else -> {
                    val local = nomeLocal(resolver(base, linha))
                    saida.append(local ?: linhaBruta)
                }
            }
            saida.append('\n')
        }
        return saida.toString()
    }

    /**
     * Atributos `CHAVE=valor` separados por virgula, com aspas opcionais.
     *
     * Virgula dentro de aspas nao separa — `CODECS="avc1.4d401f,mp4a.40.2"` e
     * um atributo so, e dividir por virgula direto quebra justamente os
     * manifestos com mais de um codec, que sao a maioria.
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
