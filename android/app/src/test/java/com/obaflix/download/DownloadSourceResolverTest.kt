package com.obaflix.download

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A recusa de fonte e a parte que protege a sessao do provedor. Se ela afrouxar,
 * o app passa a tentar baixar midia presa ao navegador — o que na melhor
 * hipotese e um 403 e na pior e alguem tentando "resolver" copiando cookie.
 */
class DownloadSourceResolverTest {

    private val AGORA = 1_700_000_000_000L

    private fun payload(vararg campos: Pair<String, Any?>): JSONObject =
        JSONObject().apply { campos.forEach { (k, v) -> put(k, v) } }

    private fun elegivel(json: JSONObject) =
        DownloadSourceResolver.classificar(json, AGORA) as DownloadElegibilidade.Elegivel

    private fun motivo(json: JSONObject) =
        (DownloadSourceResolver.classificar(json, AGORA) as DownloadElegibilidade.Inelegivel).motivo

    @Test
    fun `mp4 declarado vira fonte de mp4`() {
        val r = elegivel(
            payload(
                "stream" to "https://cdn.exemplo.com/a/b.mp4",
                "tipo" to "mp4",
                "referer" to "https://provedor.exemplo/embed",
                "userAgent" to "Mozilla/5.0",
            )
        )
        assertEquals(MediaKind.MP4, r.source.kind)
        assertEquals("https://provedor.exemplo/embed", r.source.referer)
        assertEquals("Mozilla/5.0", r.source.userAgent)
    }

    @Test
    fun `sem tipo declarado a extensao mp4 decide`() {
        assertEquals(MediaKind.MP4, elegivel(payload("stream" to "https://cdn.exemplo.com/v.mp4")).source.kind)
    }

    @Test
    fun `sem tipo e sem extensao cai em hls`() {
        // Master atras de CDN costuma nao ter ".m3u8" no caminho. Errar para HLS
        // e recuperavel (o downloader confere o #EXTM3U); errar para MP4
        // gravaria um arquivo que e texto.
        assertEquals(MediaKind.HLS, elegivel(payload("stream" to "https://cdn.exemplo.com/x/playlist")).source.kind)
    }

    @Test
    fun `manifesto em memoria e sempre recusado`() {
        // O sinal de "preso a sessao do Chromium". Vem antes de qualquer outra
        // checagem justamente para nao haver caminho que o contorne.
        assertEquals(
            MotivoInelegivel.SESSAO_DO_NAVEGADOR,
            motivo(
                payload(
                    "stream" to "https://cdn.exemplo.com/m.m3u8",
                    "tipo" to "hls",
                    "manifest" to "#EXTM3U\n#EXT-X-VERSION:3\n",
                )
            ),
        )
    }

    @Test
    fun `manifesto em memoria vence ate uma fonte que seria valida`() {
        val comManifesto = payload(
            "stream" to "https://cdn.exemplo.com/v.mp4",
            "tipo" to "mp4",
            "expiresAt" to AGORA + 3_600_000L,
            "manifest" to "#EXTM3U",
        )
        assertEquals(MotivoInelegivel.SESSAO_DO_NAVEGADOR, motivo(comManifesto))
    }

    @Test
    fun `origem superflix e recusada mesmo com stream aparentemente bom`() {
        // O caminho do Superflix passa por desafio da Cloudflare e cookie de
        // sessao; o que sai dali nao vale para outro cliente. Esta e a barreira
        // que de fato pega o caso hoje, ja que `manifest` nao atravessa a ponte.
        assertEquals(
            MotivoInelegivel.SESSAO_DO_NAVEGADOR,
            motivo(
                payload(
                    "stream" to "https://cdn.exemplo.com/m.m3u8",
                    "tipo" to "hls",
                    "origem" to "superflix",
                    "expiresAt" to AGORA + 3_600_000L,
                )
            ),
        )
    }

    @Test
    fun `origem superflix e reconhecida sem depender de caixa`() {
        assertEquals(
            MotivoInelegivel.SESSAO_DO_NAVEGADOR,
            motivo(payload("stream" to "https://cdn.exemplo.com/v.mp4", "origem" to "SuperFlix")),
        )
    }

    @Test
    fun `origem nativa comum e aceita`() {
        val r = elegivel(payload("stream" to "https://cdn.exemplo.com/v.mp4", "origem" to "nativo"))
        assertEquals(MediaKind.MP4, r.source.kind)
    }

    @Test
    fun `erro na resolucao nao vira download`() {
        assertEquals(MotivoInelegivel.SEM_STREAM, motivo(payload("error" to "superflix: 403")))
    }

    @Test
    fun `stream ausente e recusado`() {
        assertEquals(MotivoInelegivel.SEM_STREAM, motivo(payload("tipo" to "hls")))
    }

    @Test
    fun `http puro e recusado`() {
        assertEquals(MotivoInelegivel.NAO_HTTPS, motivo(payload("stream" to "http://cdn.exemplo.com/v.mp4")))
    }

    @Test
    fun `url malformada e recusada`() {
        assertEquals(MotivoInelegivel.URL_INVALIDA, motivo(payload("stream" to "nao é uma url")))
    }

    @Test
    fun `fonte ja expirada e recusada`() {
        assertEquals(
            MotivoInelegivel.EXPIRADA,
            motivo(payload("stream" to "https://cdn.exemplo.com/v.mp4", "expiresAt" to AGORA - 1L)),
        )
    }

    @Test
    fun `fonte que vence dentro da margem e recusada`() {
        // Um episodio leva minutos para baixar; comecar com 30s de token
        // sobrando produziria um arquivo pela metade em vez de um erro.
        val dentroDaMargem = AGORA + (DownloadSourceResolver.MARGEM_EXPIRACAO_MS / 2)
        assertEquals(
            MotivoInelegivel.EXPIRADA,
            motivo(payload("stream" to "https://cdn.exemplo.com/v.mp4", "expiresAt" to dentroDaMargem)),
        )
    }

    @Test
    fun `fonte com folga de validade e aceita`() {
        val r = elegivel(
            payload("stream" to "https://cdn.exemplo.com/v.mp4", "expiresAt" to AGORA + 3_600_000L)
        )
        assertEquals(AGORA + 3_600_000L, r.source.expiresAt)
    }

    @Test
    fun `expiresAt nulo nao bloqueia`() {
        val r = DownloadSourceResolver.classificar(
            payload("stream" to "https://cdn.exemplo.com/v.mp4", "expiresAt" to JSONObject.NULL),
            AGORA,
        )
        assertTrue(r is DownloadElegibilidade.Elegivel)
    }

    @Test
    fun `campos ausentes viram nulo e nao string vazia`() {
        val r = elegivel(payload("stream" to "https://cdn.exemplo.com/v.mp4"))
        assertEquals(null, r.source.referer)
        assertEquals(null, r.source.userAgent)
    }
}
