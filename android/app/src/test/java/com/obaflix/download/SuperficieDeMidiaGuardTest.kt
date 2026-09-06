package com.obaflix.download

import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

/**
 * Guardas sobre o codigo-fonte de download e transmissao.
 *
 * ## Por que ler arquivo em vez de chamar funcao
 *
 * As duas propriedades que este teste protege sao *ausencias*: "download nunca
 * aciona o gate de anuncios" e "nenhum segredo entra em log". Ausencia nao se
 * exercita chamando o codigo — um teste de comportamento passaria com o
 * primeiro `PlaybackAdGate.pode()` acrescentado num ramo que ele nao cobre.
 *
 * O gate de anuncios (`com.obaflix.ads`) nao existe neste branch. Este teste
 * vale exatamente para o momento em que ele passar a existir: se alguem ligar
 * download a contagem de episodios, a regra validada de um anuncio a cada tres
 * episodios muda sem ninguem perceber, porque baixar uma temporada inteira
 * contaria como doze intencoes de reproducao.
 */
class SuperficieDeMidiaGuardTest {

    private val fontes: List<File> by lazy {
        val raiz = File("src/main/java/com/obaflix")
        listOf(File(raiz, "download"), File(raiz, "cast"))
            .flatMap { it.walkTopDown().filter { f -> f.isFile && f.extension == "kt" } }
            .plus(File(raiz, "MediaActionsBridge.kt"))
            .filter { it.isFile }
    }

    /**
     * O arquivo sem comentarios.
     *
     * Sem isto o teste acusa a propria documentacao: o KDoc do
     * [MediaDownloader] explica que **nao** existe CookieJar, e o manifesto
     * explica que **nao** pede WRITE_EXTERNAL_STORAGE. Buscar a palavra no
     * texto inteiro transformaria "escrevemos por que isso nao acontece" em
     * falha — e o incentivo passaria a ser apagar a explicacao.
     */
    private fun semComentarios(texto: String, xml: Boolean): String {
        var t = texto
        val blocos = if (xml) Regex("<!--[\\s\\S]*?-->") else Regex("/\\*[\\s\\S]*?\\*/")
        t = t.replace(blocos, " ")
        if (!xml) {
            t = t.lines().joinToString("\n") { linha ->
                val corte = linha.indexOf("//")
                if (corte >= 0) linha.substring(0, corte) else linha
            }
        }
        return t
    }

    @Test
    fun `os arquivos que este teste protege existem`() {
        // Sem isto, mover um pacote transformaria os testes abaixo em no-op
        // silencioso — passariam varrendo uma lista vazia.
        assertTrue("nenhuma fonte encontrada em src/main/java/com/obaflix", fontes.size >= 8)
    }

    @Test
    fun `download e cast nao acionam o gate de anuncios`() {
        val proibidos = listOf(
            "PlaybackAdGate",
            "SeriesAdFrequencyPolicy",
            "AdGateBridge",
            "ObaflixAds",
            "InterstitialAdProvider",
            "AdCounterStore",
            "ads_episode_intent",
            "AD_HOLD",
            "com.obaflix.ads",
        )
        fontes.forEach { arquivo ->
            val texto = semComentarios(arquivo.readText(), xml = false)
            proibidos.forEach { simbolo ->
                assertFalse(
                    "${arquivo.name} referencia $simbolo — baixar ou transmitir nao e intencao de reproducao",
                    texto.contains(simbolo),
                )
            }
        }
    }

    @Test
    fun `nenhum log carrega url completa ou segredo`() {
        // ObaLog.url e ObaLog.host mascaram; interpolar a URL crua num campo de
        // log colocaria token e assinatura do CDN no logcat.
        val proibidos = listOf(
            "\"url\" to source.url",
            "\"url\" to fonte.url",
            "\"stream\" to atual.url",
            "cf_clearance",
            "Set-Cookie",
            "cookieJar",
            "CookieManager",
        )
        fontes.forEach { arquivo ->
            val texto = semComentarios(arquivo.readText(), xml = false)
            proibidos.forEach { trecho ->
                assertFalse("${arquivo.name} contem $trecho", texto.contains(trecho))
            }
        }
    }

    @Test
    fun `o manifesto nao pede permissao ampla de armazenamento`() {
        val manifesto = semComentarios(File("src/main/AndroidManifest.xml").readText(), xml = true)
        listOf(
            "READ_EXTERNAL_STORAGE",
            "WRITE_EXTERNAL_STORAGE",
            "MANAGE_EXTERNAL_STORAGE",
            "READ_MEDIA_VIDEO",
        ).forEach {
            assertFalse("o manifesto pede $it — a gravacao e so via SAF", manifesto.contains(it))
        }
    }

    @Test
    fun `o servico de download nao e exportado`() {
        val manifesto = File("src/main/AndroidManifest.xml").readText()
        val bloco = manifesto.substringAfter("DownloadService").substringBefore("/>")
        assertTrue(
            "DownloadService precisa de exported=\"false\": exportado, outro app enfileiraria downloads",
            bloco.contains("android:exported=\"false\""),
        )
    }
}
