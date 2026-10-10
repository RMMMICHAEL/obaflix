package com.obaflix.bridge

import com.obaflix.ObaflixApp
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import android.webkit.WebView
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.net.InetAddress
import kotlin.coroutines.CoroutineContext

class DownloadExtractionIsolationTest {
    private val publicAddress = InetAddress.getByAddress(byteArrayOf(8, 8, 8, 8))

    private fun playing() {
        ObaflixApp.playerState.resetCdnHosts("playing.example")
        ObaflixApp.playerState.allowCdnHost("segment.playing.example")
        ObaflixApp.playerState.embedReferer = "https://playing.example/watch"
        ObaflixApp.playerState.mediaUserAgent = "playback-agent"
    }

    private fun assertPlaybackIntact() {
        val state = ObaflixApp.playerState
        assertEquals("playing.example", state.cdnHostname)
        assertEquals("https://playing.example/watch", state.embedReferer)
        assertEquals("playback-agent", state.mediaUserAgent)
        assertTrue(state.isAllowedCdnHost("segment.playing.example"))
        assertFalse(state.isAllowedCdnHost("download.example"))
    }

    @Test fun resultOnlyPreservesPlaybackAndAllMediaMetadata() = runBlocking {
        playing()
        val result = StreamExtractor.resultOnly(NativeExtractResult(
            stream = "https://download.example/master.m3u8?token=secret",
            referer = "https://download.example/embed", userAgent = "download-agent",
            tipo = "hls", expiresAt = 123456789L, isMaster = true,
            qualities = listOf("720p"), audioTracks = listOf("pt"),
        )) { arrayOf(publicAddress) }
        assertEquals("hls", result.tipo)
        assertEquals("download-agent", result.userAgent)
        assertEquals(123456789L, result.expiresAt)
        assertEquals(listOf("720p"), result.qualities)
        assertEquals(listOf("pt"), result.audioTracks)
        assertPlaybackIntact()
    }

    @Test fun playbackStillExplicitlyAppliesResult() = runBlocking {
        playing()
        val result = StreamExtractor.resultOnly(NativeExtractResult(
            stream = "https://download.example/video.mp4", referer = "https://download.example/embed",
            userAgent = "new-agent", tipo = "mp4",
        )) { arrayOf(publicAddress) }
        StreamExtractor.applyToPlayback(result)
        assertEquals("download.example", ObaflixApp.playerState.cdnHostname)
        assertEquals(result.referer, ObaflixApp.playerState.embedReferer)
        assertEquals("new-agent", ObaflixApp.playerState.mediaUserAgent)
        assertFalse(ObaflixApp.playerState.isAllowedCdnHost("segment.playing.example"))
    }

    @Test fun redeCanaisDownloadResultDoesNotPublishHostsOrHeaders() = runBlocking {
        playing()
        val result = RedeCanaisExtractor.resultOnly(
            "https://media.pages.cloudflareusercontent.com/proxy?token=secret",
        ) { arrayOf(publicAddress) }
        assertEquals("https://redecanais.capital/", result.referer)
        assertEquals("mp4", result.tipo)
        assertPlaybackIntact()
        StreamExtractor.applyToPlayback(result, updateUserAgent = false)
        assertEquals("media.pages.cloudflareusercontent.com", ObaflixApp.playerState.cdnHostname)
        assertEquals("playback-agent", ObaflixApp.playerState.mediaUserAgent)
    }

    @Test fun unsafeDestinationsFailWithoutChangingPlayback() = runBlocking {
        for ((url, address) in listOf(
            "http://download.example/video.mp4" to publicAddress,
            "https://download.example/video.mp4" to InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)),
            "https://download.example/video.mp4" to InetAddress.getByAddress(byteArrayOf(10, 0, 0, 1)),
            "https://user:secret@download.example/video.mp4" to publicAddress,
        )) {
            playing()
            try {
                StreamExtractor.resultOnly(NativeExtractResult(stream = url, referer = null)) { arrayOf(address) }
                fail("unsafe destination accepted")
            } catch (_: Exception) { }
            assertPlaybackIntact()
        }
    }

    // Framework WebView needs a device; these guards verify the bridge wiring in JVM tests.
    private fun source(name: String): String = File("src/main/java/com/obaflix/bridge/$name.kt").readText()

    @Test fun downloadBridgeNeverTouchesPlaybackJobOrState() {
        val src = source("ObaflixBridge")
        val download = src.substringAfter("fun extractStreamForDownload(").substringBefore("fun prepareSuperflix(")
        assertFalse(download.contains("activeExtraction"))
        assertFalse(download.contains("playerState"))
        assertFalse(download.contains("applyToPlayback"))
        assertTrue(download.contains("downloadExtractions.put(actionId, job)?.cancel()"))
        assertTrue(download.contains("StreamExtractor.extractResult(embedUrl)"))
        assertTrue(download.contains("RedeCanaisExtractor.extractResult(webView, embedUrl)"))
        assertTrue(download.contains("authorized(capability)"))
        assertTrue(download.contains("validCallbackId(callbackId)"))
        assertTrue(download.contains("validCallbackId(actionId)"))
        assertTrue(download.contains("validatePublicHttps(embedUrl)"))
        assertFalse(download.contains("ObaLog"))
    }

    @Test fun realBridgeCancelsOnlyDownloadJobOfSameAction() {
        // Não executa tarefas enfileiradas: exercita registro/cancelamento real
        // da bridge sem rede nem framework WebView ativo.
        val dispatcher = object : CoroutineDispatcher() {
            override fun dispatch(context: CoroutineContext, block: Runnable) { }
        }
        val owner = SupervisorJob()
        val bridge = ObaflixBridge(WebView(android.app.Application()), CoroutineScope(owner + dispatcher), "capability")
        val playback = Job()
        val active = bridge.javaClass.getDeclaredField("activeExtraction").apply { isAccessible = true }
        active.set(bridge, playback)
        @Suppress("UNCHECKED_CAST")
        val downloads = bridge.javaClass.getDeclaredField("downloadExtractions").apply {
            isAccessible = true
        }.get(bridge) as Map<String, Job>
        try {
            bridge.extractStreamForDownload("wrong", "cb1", "action1", "https://lulu.gg/e/video")
            bridge.extractStreamForDownload("capability", "cb'bad", "action1", "https://lulu.gg/e/video")
            bridge.extractStreamForDownload("capability", "cb1", "action1", "http://lulu.gg/e/video")
            assertTrue(downloads.isEmpty())
            bridge.extractStreamForDownload("capability", "cb1", "action1", "https://lulu.gg/e/video")
            val first = downloads.getValue("action1")
            bridge.extractStreamForDownload("capability", "cb2", "action2", "https://lulu.gg/e/other")
            val otherAction = downloads.getValue("action2")
            assertFalse(first.isCancelled)
            bridge.extractStreamForDownload("capability", "cb3", "action1", "https://lulu.gg/e/next")
            assertTrue(first.isCancelled)
            assertFalse(otherAction.isCancelled)
            assertFalse(playback.isCancelled)
            assertSame(playback, active.get(bridge))
        } finally {
            owner.cancel()
            playback.cancel()
        }
    }

    @Test fun resultOnlyPathsCannotPublishPlayback() {
        val stream = source("StreamExtractor")
        val extract = stream.substringAfter("suspend fun extractResult(")
        assertFalse(extract.contains("applyToPlayback"))
        assertFalse(extract.contains("playerState"))
        val rede = source("RedeCanaisExtractor").substringAfter("suspend fun extractResult(")
        assertFalse(rede.contains("playerState"))
        assertFalse(rede.contains("applyToPlayback"))
        assertTrue(rede.contains("return resultOnly(stream)"))
        assertTrue(rede.contains("NonCancellable + Dispatchers.Main.immediate"))
        assertTrue(stream.contains("applyToPlayback(extractResult(embedUrl))"))
    }
}
