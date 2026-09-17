package com.obaflix

import com.obaflix.cast.CastElegibilidade
import com.obaflix.cast.CastSourceResolver
import com.obaflix.cast.MotivoSemCast
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "Transmitir" dentro do player de um episodio Playerflix.
 *
 * Reproduzido no emulador (1.0.17): o episodio tocava por
 * `http://127.0.0.1:<porta>/s/<sessao>?u=...`, o player entregava esse endereco
 * ao "Transmitir" e o classificador recusava por `nao_https` — na tela, "Nao foi
 * possivel concluir". Pela ficha, o mesmo conteudo chegava com a URL https e o
 * Web Video Cast (duble local) recebia a midia.
 */
class TransmissaoPeloProxyLocalTest {

    private val origemHttps = "https://cdn.invalido/hls/master.m3u8?t=abc"

    private fun payloadDoPlayer(stream: String) = JSONObject()
        .put("origem", "nativo")
        .put("stream", stream)
        .put("tipo", "hls")
        .put("referer", JSONObject.NULL)
        .put("pid", "serie:s1:t7:e3")

    @Test
    fun `antes da correcao o loopback era recusado como nao https`() {
        LocalMediaServer().use { server ->
            val (_, local) = server.start(origemHttps, "https://player.invalido/", "UA-teste")
            val r = CastSourceResolver.classificar(payloadDoPlayer(local), "Big Bang")
            assertEquals(CastElegibilidade.Inelegivel(MotivoSemCast.NAO_HTTPS), r)
        }
    }

    @Test
    fun `loopback do proxy vira a origem https com os headers da sessao`() {
        LocalMediaServer().use { server ->
            val (_, local) = server.start(origemHttps, "https://player.invalido/", "UA-teste")
            val payload = MediaActionsBridge.paraTransmissao(payloadDoPlayer(local)) { server.origemDe(it) }

            val r = CastSourceResolver.classificar(payload, "Big Bang")
            assertTrue(r.toString(), r is CastElegibilidade.Elegivel)
            val fonte = (r as CastElegibilidade.Elegivel).source
            assertEquals(origemHttps, fonte.url)
            assertEquals("https://player.invalido/", fonte.referer)
            assertEquals("UA-teste", fonte.userAgent)
        }
    }

    @Test
    fun `URL que nao e do proxy passa intacta`() {
        LocalMediaServer().use { server ->
            val payload = payloadDoPlayer("https://cdn.invalido/filme.mp4")
            assertSame(payload, MediaActionsBridge.paraTransmissao(payload) { server.origemDe(it) })
        }
    }

    @Test
    fun `so a porta e as sessoes deste servidor sao desfeitas`() {
        LocalMediaServer().use { server ->
            val (id, local) = server.start(origemHttps, null, null)
            val porta = local.substringAfter("127.0.0.1:").substringBefore("/")
            val consulta = local.substringAfter("?")

            assertEquals(origemHttps, server.origemDe(local)?.url)
            assertNull("outra porta", server.origemDe(local.replace(":$porta/", ":1/")))
            assertNull("outro host", server.origemDe(local.replace("127.0.0.1", "10.0.0.2")))
            assertNull("sessao inexistente", server.origemDe("http://127.0.0.1:$porta/s/outra?$consulta"))
            assertNull("sem u=", server.origemDe("http://127.0.0.1:$porta/s/$id"))
            assertNull("https no loopback nao e deste proxy", server.origemDe(local.replace("http://", "https://")))

            server.stop(id)
            assertNull("sessao encerrada", server.origemDe(local))
        }
    }

    @Test
    fun `origem que nao e https nunca sai do proxy`() {
        LocalMediaServer().use { server ->
            val (id, local) = server.start(origemHttps, null, null)
            val porta = local.substringAfter("127.0.0.1:").substringBefore("/")
            val http = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString("http://cdn.invalido/x.m3u8".toByteArray())
            assertNull(server.origemDe("http://127.0.0.1:$porta/s/$id?u=$http"))
        }
    }
}
