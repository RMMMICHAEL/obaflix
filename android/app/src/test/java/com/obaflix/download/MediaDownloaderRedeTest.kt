package com.obaflix.download

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** Montagem do pedido HTTP e a guarda de destino — sem rede de verdade. */
class MediaDownloaderRedeTest {

    private fun source(referer: String?, userAgent: String?) =
        DownloadSource("https://cdn.exemplo.com/x.ts", referer, userAgent, MediaKind.HLS, null)

    @Test
    fun `pedido preserva Referer e User-Agent`() {
        val p = MediaDownloader.pedido(
            source("https://embed.exemplo.com/", "ObaflixApp/1.0"),
            "https://cdn.exemplo.com/seg0.ts",
        )
        assertEquals("https://embed.exemplo.com/", p.header("Referer"))
        assertEquals("ObaflixApp/1.0", p.header("User-Agent"))
    }

    @Test
    fun `pedido com BYTERANGE vira header Range`() {
        val p = MediaDownloader.pedido(
            source("https://e/", "UA"),
            "https://cdn.exemplo.com/seg0.ts",
            rangeHls = "bytes=0-99",
        )
        assertEquals("bytes=0-99", p.header("Range"))
    }

    @Test
    fun `pedido de retomada MP4 pede do byte gravado em diante`() {
        val p = MediaDownloader.pedido(source("https://e/", "UA"), "https://cdn.exemplo.com/v.mp4", faixaDe = 2048L)
        assertEquals("bytes=2048-", p.header("Range"))
    }

    @Test
    fun `sem faixa nenhuma nao manda Range`() {
        val p = MediaDownloader.pedido(source("https://e/", "UA"), "https://cdn.exemplo.com/v.mp4")
        assertNull(p.header("Range"))
    }

    @Test
    fun `destino privado, loopback e nao-https sao recusados`() {
        assertFalse(MediaDownloader.destinoPublico("http://cdn.exemplo.com/x.ts")) // nao https
        assertFalse(MediaDownloader.destinoPublico("https://127.0.0.1/x.ts"))      // loopback
        assertFalse(MediaDownloader.destinoPublico("https://10.0.0.5/x.ts"))       // rede privada
        assertFalse(MediaDownloader.destinoPublico("https://192.168.1.10/x.ts"))   // rede privada
        assertFalse(MediaDownloader.destinoPublico("not a url"))
    }
}
