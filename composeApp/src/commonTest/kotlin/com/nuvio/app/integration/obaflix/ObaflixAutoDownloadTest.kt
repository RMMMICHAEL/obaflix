package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.streams.StreamBehaviorHints
import com.nuvio.app.features.streams.StreamItem
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ObaflixAutoDownloadTest {
    private val authorizeBodies = mutableListOf<String>()
    private var answer = 200 to """{"decisao":"PERMITIDO"}"""
    private val tried = mutableListOf<String>()

    private fun src(url: String?, name: String = "Fonte", addon: String = "a1", type: String? = null) = StreamItem(
        url = url, name = name, addonName = addon, addonId = addon, streamType = type, behaviorHints = StreamBehaviorHints(),
    )

    private val https720 = src("https://cdn.a.example/v/720.mp4", "720p")
    private val https1080 = src("https://cdn.b.example/v/1080.mp4", "Full HD 1080p", "b1")
    private val fenixHttp = src("http://fenixflix.fenixhub.online/r/x/video.mp4", "FenixFlix 4K", "fenix")
    private val hls = src("https://cdn.c.example/master.m3u8", "4K", "c1")

    @BeforeTest
    fun setUp() {
        ObaflixPlaybackGate.clear()
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
        ObaflixPlaybackGate.post = { _, body -> authorizeBodies += body; answer }
        ObaflixPlaybackGate.adPresenter = null
    }

    @AfterTest
    fun tearDown() {
        ObaflixSession.current = null
        ObaflixSourceProbe.check = null
        ObaflixPlaybackGate.adPresenter = null
        ObaflixPlaybackGate.clear()
    }

    @Test
    fun onlyPlainFilesAreRankedHttpsFirstThenHttpAndQualityWins() {
        val r = ObaflixDownloadPicker.rank(listOf(fenixHttp, hls, https720, https1080, src("magnet:?xt=urn:btih:abc"), src(null)))
        assertEquals(listOf(https1080, https720, fenixHttp), r) // no HLS/magnet/no-url; http last
    }

    @Test
    fun noDownloadableSourceAuthorizesNothingAndAsksNoAd() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        obaflixAutoDownload("obaflix:filme:5", scope) { tried += it.url.orEmpty(); true }(listOf(hls, src(null)))
        scope.advanceUntilIdle()
        assertTrue(authorizeBodies.isEmpty())
        assertTrue(tried.isEmpty())
    }

    @Test
    fun theBestSourceStartsOnlyAfterTheServerAuthorizesTheDownload() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        obaflixAutoDownload("obaflix:filme:5", scope) { tried += it.url.orEmpty(); true }(listOf(https720, fenixHttp, https1080))
        scope.advanceUntilIdle()
        assertEquals(1, authorizeBodies.size)
        assertTrue(authorizeBodies.single().contains("\"download\""))
        assertEquals(listOf("https://cdn.b.example/v/1080.mp4"), tried)
    }

    @Test
    fun anUnreachableOrRefusedSourceFallsThroughToTheNextWithOneAdOnly() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        ObaflixSourceProbe.check = { url, _ -> !url.contains("1080") }
        obaflixAutoDownload("obaflix:filme:5", scope) { s -> tried += s.url.orEmpty(); !s.url.orEmpty().contains("720") }(listOf(https1080, https720, fenixHttp))
        scope.advanceUntilIdle()
        assertEquals(1, authorizeBodies.size)
        // 1080 never answered as media; 720 was refused by the queue; http is the last resort.
        assertEquals(listOf("https://cdn.a.example/v/720.mp4", "http://fenixflix.fenixhub.online/r/x/video.mp4"), tried)
    }

    @Test
    fun aRefusedAuthorizationStartsNothing() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        answer = 403 to """{"error":"negado"}"""
        obaflixAutoDownload("obaflix:filme:5", scope) { tried += it.url.orEmpty(); true }(listOf(https720))
        scope.advanceUntilIdle()
        assertTrue(tried.isEmpty())
    }
}
