package com.obaflix.ads

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O contrato da publicidade no Android, depois de a decisao subir para o
 * servidor.
 *
 * A versao anterior desta integracao (branch `local/obaflix-current`) decidia no
 * aparelho: `PlaybackAdGate` escolhia se havia anuncio, `SeriesAdFrequencyPolicy`
 * contava episodios e `PrefsAdCounterStore` guardava o ciclo em
 * `SharedPreferences`. Estes testes existem para que isso nao volte por
 * distracao — o encanamento do SDK foi reaproveitado, a autoridade nao.
 */
class AdsContratoTest {

    private val pacoteAds = File("src/main/java/com/obaflix/ads")

    /**
     * O teste que guarda o motivo desta reescrita.
     *
     * Contador em `SharedPreferences` nao e autoridade comercial: limpar os
     * dados do aplicativo zerava o ciclo, e nada obrigava um cliente modificado a
     * pedir anuncio. Quem conta agora e o Redis, atras de `/api/playback/authorize`.
     */
    @Test
    fun `o nativo nao guarda contador nem politica de frequencia`() {
        val proibidos = listOf(
            "PlaybackAdGate.kt",
            "SeriesAdFrequencyPolicy.kt",
            "PrefsAdCounterStore.kt",
            "AdGateBridge.kt",
            "AdGateScript.kt",
            "AdsConfig.kt",
        )
        for (nome in proibidos) {
            assertFalse(
                "$nome decidia anuncio no aparelho; a decisao agora e do servidor",
                File(pacoteAds, nome).exists(),
            )
        }
    }

    /**
     * So codigo, sem comentario.
     *
     * O cabecalho de `ObaflixAds` cita `SharedPreferences` exatamente para dizer
     * que a versao anterior o usava e esta nao usa. Sem remover a prosa, o teste
     * acusaria a documentacao como se fosse implementacao.
     */
    private fun soCodigo(texto: String): String =
        texto.lineSequence()
            .filterNot {
                val t = it.trimStart()
                t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
            }
            .joinToString("\n")

    @Test
    fun `nenhum arquivo do pacote usa SharedPreferences`() {
        val comPrefs = pacoteAds.listFiles()
            .orEmpty()
            .filter { it.isFile && soCodigo(it.readText()).contains("SharedPreferences") }
            .map { it.name }

        assertEquals("o ciclo de anuncio nao pode viver no aparelho", emptyList<String>(), comPrefs)
    }

    /**
     * A ponte expoe uma capacidade, e ela recebe o `desafioId` que o **servidor**
     * emitiu. Nao existe metodo que libere reproducao, nem que informe plano.
     */
    @Test
    fun `a ponte expoe apenas mostrarAnuncio`() {
        val fonte = File(pacoteAds, "AdsBridge.kt").readText()

        val expostos = Regex("""@JavascriptInterface\s+fun\s+(\w+)""")
            .findAll(fonte)
            .map { it.groupValues[1] }
            .toList()

        assertEquals(listOf("mostrarAnuncio"), expostos)
    }

    /** Sem o capability da sessao, a chamada nao passa. */
    @Test
    fun `a ponte confere o capability antes de qualquer coisa`() {
        val fonte = File(pacoteAds, "AdsBridge.kt").readText()
        val corpo = fonte.substringAfter("fun mostrarAnuncio(")
        assertTrue(
            "o capability precisa ser a primeira barreira",
            corpo.indexOf("if (capability != this.capability) return") in 0..200,
        )
    }

    /**
     * O `desafioId` volta inalterado na conclusao. E o que amarra a resposta ao
     * pedido: uma callback tardia de um desafio anterior chega ao JS com o id
     * antigo e e descartada la.
     */
    @Test
    fun `a conclusao devolve o desafioId ao JavaScript`() {
        val fonte = File(pacoteAds, "AdsBridge.kt").readText()
        assertTrue(fonte.contains("__obaflixAnuncioConcluido"))
        assertTrue("o id vai por JSONObject.quote, nao concatenado", fonte.contains("JSONObject.quote(desafioId)"))
    }

    /**
     * O script injetado nao decide nada — so expoe a capacidade. O anterior tinha
     * 672 linhas porque precisava adivinhar quando havia intencao de reproduzir;
     * agora a interface React pede explicitamente.
     */
    @Test
    fun `o script injetado nao contem regra de negocio`() {
        val script = AdsScript.montar("cap-de-teste")

        for (proibido in listOf("episodio", "contador", "plano", "premium", "gratuito", "localStorage")) {
            assertFalse(
                "$proibido nao pertence ao script injetado",
                script.lowercase().contains(proibido),
            )
        }
    }

    /** O capability entra por `JSONObject.quote` — nunca por concatenacao. */
    @Test
    fun `o capability e escapado no script`() {
        val comAspas = """cap"; alert(1); //"""
        val script = AdsScript.montar(comAspas)

        assertTrue(script.contains(JSONObject.quote(comAspas)))
        assertFalse("aspas cruas escapariam do literal", script.contains("""capability: "cap"; alert"""))
    }

    @Test
    fun `o script expoe obaflixAds congelado e nao reescrevivel`() {
        val script = AdsScript.montar("cap")
        assertTrue(script.contains("Object.freeze"))
        assertTrue(script.contains("writable: false"))
        assertTrue(script.contains("configurable: false"))
    }

    /**
     * O `:tv` nao monetiza nesta fase, e nao deve nem conhecer a dependencia.
     * O teste le o gradle da TV a partir do modulo `:app`.
     */
    @Test
    fun `o modulo tv nao tem dependencia de anuncio`() {
        val gradleTv = File("../tv/build.gradle").readText().lowercase()
        for (rede in listOf("unity", "admob", "play-services-ads", "applovin", "ironsource")) {
            assertFalse(":tv nao pode depender de $rede", gradleTv.contains(rede))
        }
    }
}
