package com.obaflix

import com.obaflix.download.QualidadeDownload
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * O rotulo "Padrão" da escolha de qualidade chegava a tela como "PadrÃ£o".
 *
 * A ponte envia o JSON em base64 de bytes UTF-8, e o JavaScript decodificava
 * com `atob`, que devolve um caractere por byte. Aqui o passo do navegador e
 * reproduzido nos dois jeitos: o antigo corrompe, o novo preserva.
 */
class MediaActionsBridgeUtf8Test {

    private fun base64Utf8(json: JSONObject): String =
        Base64.getEncoder().encodeToString(json.toString().toByteArray(Charsets.UTF_8))

    /** O que `atob` devolve: um char por byte, sem interpretar UTF-8. */
    private fun atob(b64: String): String = String(Base64.getDecoder().decode(b64), Charsets.ISO_8859_1)

    /** O que `Uint8Array.from(atob(..), charCodeAt)` + `TextDecoder('utf-8')` devolve. */
    private fun atobComTextDecoder(b64: String): String =
        String(atob(b64).map { it.code.toByte() }.toByteArray(), Charsets.UTF_8)

    private val resposta = JSONObject()
        .put("ok", true)
        .put("qualidades", QualidadeDownload.listaParaJson(listOf(QualidadeDownload.padrao())))

    @Test
    fun `atob sozinho corrompe o rotulo Padrao`() {
        val lido = JSONObject(atob(base64Utf8(resposta)))
        val label = lido.getJSONArray("qualidades").getJSONObject(0).getString("label")
        assertNotEquals("Padrão", label)
        assertEquals("PadrÃ£o", label)
    }

    @Test
    fun `decodificando os bytes como UTF-8 o rotulo chega como Padrao`() {
        val lido = JSONObject(atobComTextDecoder(base64Utf8(resposta)))
        assertEquals("Padrão", lido.getJSONArray("qualidades").getJSONObject(0).getString("label"))
    }

    @Test
    fun `a expressao gerada decodifica UTF-8 e nao usa atob direto no JSON`() {
        val expressao = MediaActionsBridge.jsonDeBase64Utf8("QUJD")
        assertTrue(expressao.contains("new TextDecoder('utf-8')"))
        assertTrue(expressao.contains("atob('QUJD')"))
        assertFalse(expressao.contains("JSON.parse(atob("))
    }
}
