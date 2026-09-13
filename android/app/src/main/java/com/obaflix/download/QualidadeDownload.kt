package com.obaflix.download

import org.json.JSONArray
import org.json.JSONObject

/**
 * Uma opcao de qualidade oferecida ao usuario antes de baixar.
 *
 * ## O que pode virar um rotulo, e o que nao pode
 *
 * `label` so contem "1080p", "720p" e afins quando o manifesto **declarou**
 * `RESOLUTION` naquela variante. Nao ha deducao a partir de BANDWIDTH, nome de
 * arquivo, nome de servidor ou ordem no manifesto: um rotulo errado aqui faz a
 * pessoa escolher 1080p e receber outra coisa, e ela nao tem como saber.
 *
 * Quando nao da para nomear com honestidade, a lista vira uma opcao unica
 * [PADRAO] — que significa "a fonte nao diz qual e a resolucao", nao "a melhor".
 */
data class QualidadeDownload(
    /** Id estavel dentro da sondagem. "padrao" ou "v<indice>" do master. */
    val id: String,
    val label: String,
    /** Altura em pixels, 0 quando o manifesto nao declara. */
    val altura: Int,
    /**
     * URL da variante ja resolvida contra o master.
     *
     * null significa "baixe a propria fonte" — o caso de MP4 e de playlist de
     * midia sem master. Quando ha URL, e ela que vai para o downloader, e por
     * isso a escolha do usuario nao pode ser desfeita depois: o que chega la
     * ja e a variante escolhida, nao um master para reescolher.
     */
    val uri: String?,
) {
    fun paraJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("label", label)
        put("altura", altura)
    }

    companion object {
        const val ID_PADRAO = "padrao"

        /** A opcao unica de quando a fonte nao expoe resolucao. */
        fun padrao(): QualidadeDownload =
            QualidadeDownload(ID_PADRAO, "Padrão", 0, null)

        /**
         * Converte as variantes de um master em opcoes.
         *
         * Devolve uma lista com so o "Padrao" quando **alguma** variante nao
         * declara resolucao. Misturar "1080p", "720p" e "Padrao" na mesma lista
         * seria pior que nao oferecer escolha: o "Padrao" pareceria uma
         * qualidade a mais, quando na verdade e uma variante que nao sabemos
         * nomear.
         */
        fun deVariantes(
            variantes: List<HlsPlaylist.Variante>,
            urlDoMaster: String,
        ): List<QualidadeDownload> {
            if (variantes.isEmpty()) return listOf(padrao())

            val comAltura = variantes.mapIndexed { indice, variante ->
                indice to HlsPlaylist.alturaDe(variante.resolucao)
            }
            if (comAltura.any { it.second <= 0 }) return listOf(padrao())

            return comAltura
                .map { (indice, altura) ->
                    QualidadeDownload(
                        id = HlsPlaylist.idDaVariante(indice),
                        label = "${altura}p",
                        altura = altura,
                        uri = HlsPlaylist.resolver(urlDoMaster, variantes[indice].uri),
                    )
                }
                // Maior primeiro: e a ordem em que a pessoa procura, e a que a
                // lista de qualidade de qualquer player usa.
                .sortedByDescending { it.altura }
                // Duas variantes com a mesma altura (audios diferentes) virariam
                // dois botoes "720p" indistinguiveis na tela.
                .distinctBy { it.altura }
        }

        fun listaParaJson(qualidades: List<QualidadeDownload>): JSONArray {
            val array = JSONArray()
            qualidades.forEach { array.put(it.paraJson()) }
            return array
        }
    }
}
