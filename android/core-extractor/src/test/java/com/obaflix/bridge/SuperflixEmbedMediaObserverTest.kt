package com.obaflix.bridge

import com.obaflix.bridge.SuperflixEmbedMediaObserver.Conteudo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Classificação do observador do player externo.
 *
 * Só as partes puras: quem depende de WebView continua sendo validado em
 * aparelho. O que estes testes protegem é a regra que já custou caro — nada
 * vira mídia por o caminho "parecer aleatório"; ou a extensão diz, ou o corpo
 * diz.
 */
class SuperflixEmbedMediaObserverTest {

    private fun bytes(texto: String) = texto.toByteArray(Charsets.ISO_8859_1)

    /** Caixa MP4: 4 bytes de tamanho e o tipo logo em seguida. */
    private fun caixaMp4(tipo: String): ByteArray =
        byteArrayOf(0, 0, 0, 0x20) + tipo.toByteArray(Charsets.ISO_8859_1) +
            "isomiso2avc1mp41".toByteArray(Charsets.ISO_8859_1)

    // ── Extensão ───────────────────────────────────────────────────────────

    @Test
    fun `extensao reconhece hls e mp4`() {
        assertEquals("hls", SuperflixEmbedMediaObserver.tipoPorExtensao("https://h.tld/a/b.m3u8"))
        assertEquals("hls", SuperflixEmbedMediaObserver.tipoPorExtensao("https://h.tld/cdn/hls/x/master.txt"))
        assertEquals("mp4", SuperflixEmbedMediaObserver.tipoPorExtensao("https://h.tld/v/f.mp4?t=1"))
    }

    @Test
    fun `caminho opaco nao vira midia pela aparencia`() {
        assertNull(SuperflixEmbedMediaObserver.tipoPorExtensao("https://h.tld/video/9f3a1c8e2b7d4506"))
        assertNull(SuperflixEmbedMediaObserver.tipoPorExtensao("https://h.tld/m3/aBcD1234"))
    }

    // ── Corpo ──────────────────────────────────────────────────────────────

    @Test
    fun `master se distingue de playlist de midia`() {
        val master = bytes(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360/index.m3u8\n",
        )
        assertEquals(Conteudo.HLS_MASTER, SuperflixEmbedMediaObserver.classificar(master))

        val midia = bytes(
            "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n",
        )
        assertEquals(Conteudo.HLS_MEDIA, SuperflixEmbedMediaObserver.classificar(midia))
    }

    @Test
    fun `manifesto com BOM e espaco a frente ainda e reconhecido`() {
        val comBom = "﻿\n  #EXTM3U\n#EXTINF:4.0,\na.ts\n".toByteArray(Charsets.UTF_8)
        assertEquals(Conteudo.HLS_MEDIA, SuperflixEmbedMediaObserver.classificar(comBom))
    }

    @Test
    fun `assinaturas de mp4 sao reconhecidas`() {
        assertEquals(Conteudo.MP4, SuperflixEmbedMediaObserver.classificar(caixaMp4("ftyp")))
        assertEquals(Conteudo.MP4, SuperflixEmbedMediaObserver.classificar(caixaMp4("styp")))
        assertEquals(Conteudo.MP4, SuperflixEmbedMediaObserver.classificar(caixaMp4("moof")))
    }

    @Test
    fun `corpo que nao e midia nao classifica`() {
        assertNull(SuperflixEmbedMediaObserver.classificar(bytes("")))
        assertNull(SuperflixEmbedMediaObserver.classificar(bytes("<!DOCTYPE html><html>")))
        assertNull(SuperflixEmbedMediaObserver.classificar(bytes("{\"ok\":true}")))
        // "ftyp" tarde demais para ser a primeira caixa.
        assertNull(
            SuperflixEmbedMediaObserver.classificar(
                bytes("x".repeat(40) + "ftyp"),
            ),
        )
    }

    // ── Candidata ──────────────────────────────────────────────────────────

    @Test
    fun `tipo e master saem da classificacao do corpo`() {
        val master = SuperflixEmbedMediaObserver.Candidata("https://h.tld/a", Conteudo.HLS_MASTER)
        assertEquals("hls", master.tipo)
        assertTrue(master.ehMaster)

        val midia = SuperflixEmbedMediaObserver.Candidata("https://h.tld/a", Conteudo.HLS_MEDIA)
        assertEquals("hls", midia.tipo)
        assertFalse(midia.ehMaster)

        val mp4 = SuperflixEmbedMediaObserver.Candidata("https://h.tld/a", Conteudo.MP4)
        assertEquals("mp4", mp4.tipo)
        assertFalse(mp4.ehMaster)
    }

    // ── Ruído ──────────────────────────────────────────────────────────────

    @Test
    fun `ruido conhecido e descartado antes de qualquer requisicao`() {
        assertTrue(SuperflixEmbedMediaObserver.ehRuido("https://www.google-analytics.com/collect"))
        assertTrue(SuperflixEmbedMediaObserver.ehRuido("https://h.tld/ads/banner"))
        assertTrue(SuperflixEmbedMediaObserver.ehRuido("https://h.tld/player/hls.js"))
        assertTrue(SuperflixEmbedMediaObserver.ehRuido("https://h.tld/logo.png"))
        assertTrue(SuperflixEmbedMediaObserver.ehRuido("nao-e-url"))

        assertFalse(SuperflixEmbedMediaObserver.ehRuido("https://h.tld/cdn/hls/x/master.txt"))
        assertFalse(SuperflixEmbedMediaObserver.ehRuido("https://h.tld/video/9f3a1c8e2b7d4506"))
    }
}
