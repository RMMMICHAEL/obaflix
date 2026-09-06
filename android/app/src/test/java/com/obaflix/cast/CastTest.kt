package com.obaflix.cast

import com.obaflix.download.MediaKind
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CastSourceResolverTest {

    private val AGORA = 1_700_000_000_000L

    private fun payload(vararg campos: Pair<String, Any?>): JSONObject =
        JSONObject().apply { campos.forEach { (k, v) -> put(k, v) } }

    private fun elegivel(json: JSONObject, poster: String? = null) =
        CastSourceResolver.classificar(json, "Episodio 1", poster, AGORA) as CastElegibilidade.Elegivel

    private fun motivo(json: JSONObject) =
        (CastSourceResolver.classificar(json, "Episodio 1", null, AGORA) as CastElegibilidade.Inelegivel).motivo

    @Test
    fun `hls elegivel usa o mime de HLS`() {
        val r = elegivel(payload("stream" to "https://cdn.exemplo.com/m.m3u8", "tipo" to "hls"))
        assertEquals(MediaKind.HLS, r.source.kind)
        assertEquals("application/x-mpegURL", r.source.mimeType)
        assertEquals("Episodio 1", r.source.titulo)
    }

    @Test
    fun `mp4 elegivel usa o mime de video`() {
        assertEquals(
            "video/mp4",
            elegivel(payload("stream" to "https://cdn.exemplo.com/v.mp4", "tipo" to "mp4")).source.mimeType,
        )
    }

    @Test
    fun `midia presa a sessao do navegador nao vai para app externo`() {
        // O ponto onde o cast e mais perigoso que o download: falhar aqui
        // significaria entregar a URL a um processo que nao controlamos.
        assertEquals(
            MotivoSemCast.SESSAO_DO_NAVEGADOR,
            motivo(payload("stream" to "https://cdn.exemplo.com/m.m3u8", "manifest" to "#EXTM3U")),
        )
    }

    @Test
    fun `fonte expirada nao vai para app externo`() {
        assertEquals(
            MotivoSemCast.EXPIRADA,
            motivo(payload("stream" to "https://cdn.exemplo.com/v.mp4", "expiresAt" to AGORA - 1L)),
        )
    }

    @Test
    fun `http puro nao vai para app externo`() {
        assertEquals(MotivoSemCast.NAO_HTTPS, motivo(payload("stream" to "http://cdn.exemplo.com/v.mp4")))
    }

    @Test
    fun `erro de resolucao nao vai para app externo`() {
        assertEquals(MotivoSemCast.SEM_STREAM, motivo(payload("error" to "falhou")))
    }

    @Test
    fun `poster inseguro e descartado`() {
        val r = elegivel(payload("stream" to "https://cdn.exemplo.com/v.mp4"), poster = "http://x.exemplo/p.jpg")
        assertNull(r.source.poster)
    }

    @Test
    fun `poster https e mantido`() {
        val r = elegivel(payload("stream" to "https://cdn.exemplo.com/v.mp4"), poster = "https://img.exemplo/p.jpg")
        assertEquals("https://img.exemplo/p.jpg", r.source.poster)
    }
}

class WebVideoCastTest {

    private fun fonte(referer: String? = null, userAgent: String? = null, kind: MediaKind = MediaKind.HLS) =
        CastSource(
            url = "https://cdn.exemplo.com/m.m3u8?token=abc123",
            referer = referer,
            userAgent = userAgent,
            kind = kind,
            titulo = "Episodio 1",
            poster = "https://img.exemplo/p.jpg",
        )

    @Test
    fun `aponta para o pacote do Web Video Cast`() {
        val spec = WebVideoCast.especificacao(fonte())
        assertEquals("com.instantbits.cast.webvideo", spec.pacote)
        assertEquals("android.intent.action.VIEW", spec.acao)
    }

    @Test
    fun `leva mime titulo e poster`() {
        val spec = WebVideoCast.especificacao(fonte())
        assertEquals("application/x-mpegURL", spec.mimeType)
        assertEquals("Episodio 1", spec.titulo)
        assertEquals("https://img.exemplo/p.jpg", spec.poster)
    }

    @Test
    fun `mp4 vai com o mime de video`() {
        assertEquals("video/mp4", WebVideoCast.especificacao(fonte(kind = MediaKind.MP4)).mimeType)
    }

    @Test
    fun `manda apenas Referer e User-Agent`() {
        val spec = WebVideoCast.especificacao(
            fonte(referer = "https://provedor.exemplo/embed", userAgent = "Mozilla/5.0")
        )
        assertEquals(setOf("Referer", "User-Agent"), spec.headers.keys)
        assertEquals("https://provedor.exemplo/embed", spec.headers["Referer"])
    }

    @Test
    fun `nao existe caminho que mande cookie`() {
        // CastSource nem carrega o campo; isto guarda contra alguem adicionar um
        // header extra derivado de sessao numa mudanca futura.
        val spec = WebVideoCast.especificacao(
            fonte(referer = "https://provedor.exemplo/embed", userAgent = "Mozilla/5.0")
        )
        val chaves = spec.headers.keys.map { it.lowercase() }
        assertFalse(chaves.any { it.contains("cookie") })
        assertFalse(chaves.any { it.contains("authorization") })
        val valores = spec.headers.values.joinToString(" ").lowercase()
        assertFalse(valores.contains("cf_clearance"))
        assertFalse(valores.contains("turnstile"))
    }

    @Test
    fun `sem referer nem user agent nao manda header nenhum`() {
        assertTrue(WebVideoCast.especificacao(fonte()).headers.isEmpty())
    }
}
