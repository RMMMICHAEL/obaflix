package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.streams.StreamBehaviorHints
import com.nuvio.app.features.streams.StreamItem
import com.nuvio.app.features.streams.StreamProxyHeaders
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ObaflixAutoCastTest {
    private val authorizeBodies = mutableListOf<String>()
    private var answer = 200 to """{"decisao":"PERMITIDO"}"""
    private val handed = mutableListOf<ObaflixCastRequest>()
    private var ads = 0

    private fun src(
        url: String?,
        name: String = "Fonte",
        addon: String = "a1",
        type: String? = null,
        headers: Map<String, String>? = null,
        notWebReady: Boolean = false,
    ) = StreamItem(
        url = url, name = name, addonName = addon, addonId = addon, streamType = type,
        behaviorHints = StreamBehaviorHints(
            notWebReady = notWebReady,
            proxyHeaders = headers?.let { StreamProxyHeaders(request = it) },
        ),
    )

    private val fenixHttp = src("http://fenixflix.fenixhub.online/r/x/video.mp4", "FenixFlix 4K", "fenix")
    private val https720 = src("https://cdn.a.example/v/720.mp4", "720p", "a1")
    private val https1080 = src("https://cdn.b.example/v/1080.mp4?t=1", "Full HD 1080p", "b1")
    private val hls4k = src("https://cdn.c.example/master.m3u8", "4K", "c1")
    private fun ranked(vararg s: StreamItem, own: (StreamItem) -> Boolean = { false }) =
        ObaflixCastPicker.rank(s.toList(), "T", null, own)

    @BeforeTest
    fun setUp() {
        ObaflixPlaybackGate.clear()
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
        ObaflixPlaybackGate.post = { _, body -> authorizeBodies += body; answer }
        ObaflixPlaybackGate.adPresenter = null
        ObaflixCast.handoff = { request -> handed += request; ObaflixCastResult.OPENED }
        ObaflixCast.verificarApp = { ObaflixCastResult.OPENED }
    }

    @AfterTest
    fun tearDown() {
        ObaflixSession.current = null
        ObaflixCast.handoff = null
        ObaflixCast.verificarApp = null
        ObaflixPlaybackGate.adPresenter = null
        ObaflixPlaybackGate.clear()
    }

    @Test
    fun prefersTheHighestQualityAmongProvenHttpsSourcesAcrossProviders() {
        val r = ranked(https720, fenixHttp, https1080, hls4k)
        assertEquals(listOf(hls4k, https1080, https720), r.candidates.map { it.stream })
        assertFalse(r.onlyInsecure)
    }

    @Test
    fun tiesKeepTheListedOrderSoNoProviderIsHardWired() {
        val a = src("https://x.example/a.mp4", "HD", "a1")
        val b = src("https://y.example/b.mp4", "HD", "b1")
        assertEquals(listOf(a, b), ranked(a, b).candidates.map { it.stream })
        assertEquals(listOf(b, a), ranked(b, a).candidates.map { it.stream })
    }

    @Test
    fun httpIsNeverUsedNorUpgradedAndIsReportedWhenItIsAllThereIs() {
        val r = ranked(fenixHttp)
        assertTrue(r.candidates.isEmpty())
        assertTrue(r.onlyInsecure)
        assertFalse(ranked(fenixHttp, https720).onlyInsecure) // a proven source exists: nothing to warn about
    }

    @Test
    fun aUrlIsNotCompatibleJustBecauseItExists() {
        val unknownFormat = src("https://cdn.example/watch?id=7")
        val cookieNeeded = src("https://cdn.example/a.mp4", headers = mapOf("Cookie" to "s=1"))
        val notReady = src("https://cdn.example/b.mp4", notWebReady = true)
        val torrent = src("magnet:?xt=urn:btih:abc")
        val noUrl = src(null)
        assertTrue(ranked(unknownFormat, cookieNeeded, notReady, torrent, noUrl).candidates.isEmpty())
        val refererOnly = src("https://cdn.example/c.mp4", headers = mapOf("Referer" to "https://e/", "User-Agent" to "UA"))
        assertEquals(1, ranked(refererOnly).candidates.size)
    }

    @Test
    fun ownServersComeAfterEveryProvenSource() {
        val own = src(null, "Obaflix HD 1080", "obaflix")
        val r = ranked(own, https720, own = { it === own })
        assertEquals(listOf(https720, own), r.candidates.map { it.stream })
        assertEquals(ObaflixCastPicker.Tier.OWN_SERVER, r.candidates.last().tier)
    }

    @Test
    fun noCompatibleSourceAuthorizesNothingAndAsksForNoAd() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        obaflixAutoCast("obaflix:filme:5", "T", null, scope)(listOf(fenixHttp, src(null)))
        scope.advanceUntilIdle()
        assertTrue(authorizeBodies.isEmpty())
        assertTrue(handed.isEmpty())
    }

    @Test
    fun aMissingCastAppIsHandledBeforeAnyAuthorization() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        ObaflixCast.verificarApp = { ObaflixCastResult.STORE_OPENED }
        obaflixAutoCast("obaflix:filme:5", "T", null, scope)(listOf(https720))
        scope.advanceUntilIdle()
        assertTrue(authorizeBodies.isEmpty())
        assertTrue(handed.isEmpty())
    }

    @Test
    fun theBestSourceIsHandedOverOnlyAfterTheServerAuthorizes() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        obaflixAutoCast("obaflix:filme:5", "T", null, scope)(listOf(https720, hls4k, fenixHttp, https1080))
        scope.advanceUntilIdle()
        assertEquals(1, authorizeBodies.size)
        assertTrue(authorizeBodies.single().contains("\"transmissao\""))
        assertEquals(listOf("https://cdn.c.example/master.m3u8"), handed.map { it.url })
        assertTrue(handed.single().isHls)
    }

    @Test
    fun aRefusedAuthorizationOrDeclinedAdHandsNothingOver() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        answer = 200 to """{"decisao":"NEGADO"}"""
        obaflixAutoCast("obaflix:filme:5", "T", null, scope)(listOf(https720))
        scope.advanceUntilIdle()
        assertTrue(handed.isEmpty())

        answer = 200 to """{"decisao":"ANUNCIO_NECESSARIO","desafioId":"d1"}"""
        ObaflixPlaybackGate.adPresenter = object : ObaflixAdPresenter {
            override suspend fun show(): Boolean { ads++; return true }
            override suspend fun confirmar(finalidade: String, alternativaDoRewarded: Boolean) = false // user cancels
        }
        obaflixAutoCast("obaflix:filme:5", "T", null, scope)(listOf(https720))
        scope.advanceUntilIdle()
        assertTrue(handed.isEmpty())
        assertEquals(0, ads)
    }

    @Test
    fun anExemptAccountCastsWithoutAnAd() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        answer = 200 to """{"decisao":"PERMITIDO"}"""
        obaflixAutoCast("obaflix:filme:5", "T", null, scope)(listOf(https1080))
        scope.advanceUntilIdle()
        assertEquals(1, handed.size)
        assertEquals(0, ads)
    }
}
