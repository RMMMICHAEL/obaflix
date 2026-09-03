package com.obaflix.bridge

import com.obaflix.bridge.SuperflixEmbedMediaObserver.Conteudo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tradução da prova que vem do contexto do navegador.
 *
 * Só as partes puras; o que depende de WebView continua sendo validado em
 * aparelho. O que estes testes protegem é a regra que já custou caro: nada vira
 * mídia por o caminho "parecer aleatório", e nada vira mídia sem a página ter
 * de fato consumido a resposta com 2xx.
 */
class SuperflixEmbedMediaObserverTest {

    private fun mensagem(
        url: String,
        status: Int,
        corpo: String? = null,
    ): String = buildString {
        append("{\"u\":\"").append(url).append("\",\"s\":").append(status)
        if (corpo != null) {
            append(",\"b\":\"").append(corpo.replace("\n", "\\n")).append("\"")
        }
        append("}")
    }

    private val master =
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360/index.m3u8\n"
    private val playlist =
        "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n"

    // ── Status ─────────────────────────────────────────────────────────────

    @Test
    fun `resposta que nao foi 2xx nunca vira midia`() {
        // É o resultado medido em aparelho: 403 é o que uma requisição fora da
        // sessão do Chromium recebe. Nada disso pode virar candidata.
        assertNull(
            SuperflixEmbedMediaObserver.candidataDaMensagem(
                mensagem("https://h.tld/cdn/hls/x/master.txt", 403, master),
            ),
        )
        assertNull(
            SuperflixEmbedMediaObserver.candidataDaMensagem(
                mensagem("https://h.tld/a.m3u8", 302),
            ),
        )
        assertNull(
            SuperflixEmbedMediaObserver.candidataDaMensagem(
                mensagem("https://h.tld/a.m3u8", 0),
            ),
        )
    }

    @Test
    fun `2xx com master traz o manifesto junto`() {
        val c = SuperflixEmbedMediaObserver.candidataDaMensagem(
            mensagem("https://h.tld/cdn/hls/x/master.txt", 200, master),
        )
        assertEquals(Conteudo.HLS_MASTER, c?.conteudo)
        assertEquals("hls", c?.tipo)
        assertTrue(c!!.ehMaster)
        assertTrue(c.manifesto!!.contains("#EXT-X-STREAM-INF"))
        assertEquals(200, c.status)
    }

    @Test
    fun `playlist de midia e reconhecida mas nao e master`() {
        val c = SuperflixEmbedMediaObserver.candidataDaMensagem(
            mensagem("https://h.tld/x/index.m3u8", 206, playlist),
        )
        assertEquals(Conteudo.HLS_MEDIA, c?.conteudo)
        assertFalse(c!!.ehMaster)
    }

    @Test
    fun `mp4 e aceito pela extensao e nunca carrega corpo`() {
        val c = SuperflixEmbedMediaObserver.candidataDaMensagem(
            mensagem("https://h.tld/v/filme.mp4?t=1", 200),
        )
        assertEquals(Conteudo.MP4, c?.conteudo)
        assertEquals("mp4", c?.tipo)
        assertNull("MP4 nunca pode atravessar a ponte em memória", c?.manifesto)
    }

    // ── Mensagem malformada ────────────────────────────────────────────────

    @Test
    fun `mensagem de pagina de terceiro e dado, e dado ruim nao vira midia`() {
        assertNull(SuperflixEmbedMediaObserver.candidataDaMensagem(null))
        assertNull(SuperflixEmbedMediaObserver.candidataDaMensagem(""))
        assertNull(SuperflixEmbedMediaObserver.candidataDaMensagem("nao e json"))
        assertNull(SuperflixEmbedMediaObserver.candidataDaMensagem("{\"s\":200}"))
        // 2xx, mas nem o corpo nem a extensão dizem que é mídia.
        assertNull(
            SuperflixEmbedMediaObserver.candidataDaMensagem(
                mensagem("https://h.tld/api/ping", 200, "{\\\"ok\\\":true}"),
            ),
        )
    }

    // ── Classificação do manifesto ─────────────────────────────────────────

    @Test
    fun `master se distingue de playlist de midia`() {
        assertEquals(Conteudo.HLS_MASTER, SuperflixEmbedMediaObserver.classificarManifesto(master))
        assertEquals(Conteudo.HLS_MEDIA, SuperflixEmbedMediaObserver.classificarManifesto(playlist))
        assertNull(SuperflixEmbedMediaObserver.classificarManifesto(null))
        assertNull(SuperflixEmbedMediaObserver.classificarManifesto(""))
        assertNull(SuperflixEmbedMediaObserver.classificarManifesto("<!DOCTYPE html>"))
    }

    @Test
    fun `manifesto com BOM e espaco a frente ainda e reconhecido`() {
        assertEquals(
            Conteudo.HLS_MEDIA,
            SuperflixEmbedMediaObserver.classificarManifesto("\uFEFF\n  " + playlist),
        )
    }

    // ── Extensão ───────────────────────────────────────────────────────────

    @Test
    fun `caminho opaco nao vira midia pela aparencia`() {
        assertNull(SuperflixEmbedMediaObserver.tipoPorExtensao("https://h.tld/video/9f3a1c8e2b7d4506"))
        assertNull(SuperflixEmbedMediaObserver.tipoPorExtensao("https://h.tld/m3/aBcD1234"))
        assertEquals("hls", SuperflixEmbedMediaObserver.tipoPorExtensao("https://h.tld/a/b.m3u8"))
        assertEquals("mp4", SuperflixEmbedMediaObserver.tipoPorExtensao("https://h.tld/v/f.mp4?t=1"))
    }

    // ── Script injetado ────────────────────────────────────────────────────

    @Test
    fun `script nao usa cifrao, para nao virar interpolacao Kotlin`() {
        val script = SuperflixEmbedMediaObserver.scriptDeInstrumentacao()
        assertFalse(
            "um cifrao solto no script viraria template Kotlin e o JS sairia quebrado",
            script.contains("$"),
        )
        // Só embrulha; não lê cookie, não lê storage, não toca em token.
        assertTrue(script.contains("window.fetch"))
        assertTrue(script.contains("XMLHttpRequest"))
        assertFalse(script.contains("document.cookie"))
        assertFalse(script.contains("localStorage"))
    }
}
