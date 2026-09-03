package com.obaflix.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Partes puras do wrapper: escape do endereco, forma do documento e casamento
 * de rota. Nada aqui toca WebView — o que depende dela continua sendo validado
 * em aparelho.
 */
class SuperflixWrapperHostTest {

    @Test
    fun `documento embute o endereco como string de script`() {
        val doc = SuperflixWrapperHost.documento(
            "https://superflixapi.pro/filme/123?a=1&b=2",
            "abc123",
        )
        assertTrue(doc.contains("f.src=\"https://superflixapi.pro/filme/123?a=1\\u0026b=2\""))
        assertTrue(doc.contains("<iframe id=\"f\""))
        assertTrue(doc.contains("content=\"no-referrer\""))
        assertTrue(doc.contains("/superflix/abc123/sinal/"))
    }

    @Test
    fun `escape impede fechar a string ou a tag script`() {
        val doc = SuperflixWrapperHost.documento(
            "https://superflixapi.pro/x\"</script><script>alert(1)</script>",
            "n",
        )
        // Nenhuma tag nova pode nascer do endereco.
        assertEquals(1, Regex("<script>").findAll(doc).count())
        assertFalse(doc.contains("alert(1)</script>"))
        assertTrue(doc.contains("\\u003c/script\\u003e"))
    }

    @Test
    fun `rota so vale com o nonce da sessao`() {
        assertEquals("wrapper.html", SuperflixWrapperHost.rotaDe("abc/wrapper.html", "abc"))
        assertEquals("wrapper.html", SuperflixWrapperHost.rotaDe("/abc/wrapper.html", "abc"))
        assertEquals(
            "sinal/documento/1/1",
            SuperflixWrapperHost.rotaDe("abc/sinal/documento/1/1", "abc"),
        )
        assertNull(SuperflixWrapperHost.rotaDe("outro/wrapper.html", "abc"))
        // Sessao encerrada: nenhum caminho serve.
        assertNull(SuperflixWrapperHost.rotaDe("abc/wrapper.html", ""))
    }

    @Test
    fun `aspasJs neutraliza separadores de linha do JavaScript`() {
        assertEquals("\"a\\u2028b\"", SuperflixWrapperHost.aspasJs("a\u2028b"))
        assertEquals("\"a\\\\b\"", SuperflixWrapperHost.aspasJs("a\\b"))
    }
}
