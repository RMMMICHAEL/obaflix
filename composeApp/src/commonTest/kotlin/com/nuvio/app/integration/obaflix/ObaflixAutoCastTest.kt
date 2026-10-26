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
        ObaflixSourceProbe.check = null
        ObaflixPlaybackGate.adPresenter = null
        ObaflixPlaybackGate.clear()
    }

    @Test
    fun prefersTheHighestQualityAmongProvenHttpsSourcesAcrossProviders() {
        val r = ranked(https720, fenixHttp, https1080, hls4k)
        assertEquals(listOf(hls4k, https1080, https720, fenixHttp), r.candidates.map { it.stream }) // http only after every https
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
    fun httpIsTheLastResortAndIsNeverUpgraded() {
        val r = ranked(fenixHttp)
        assertEquals(listOf(fenixHttp), r.candidates.map { it.stream })
        assertEquals(ObaflixCastPicker.Tier.INSECURE, r.candidates.single().tier)
        assertTrue(r.onlyInsecure)
        assertFalse(ranked(fenixHttp, https720).onlyInsecure)
        assertEquals("http://fenixflix.fenixhub.online/r/x/video.mp4", ObaflixCast.requestFor(fenixHttp, "T", null, allowInsecure = true)!!.url)
        assertEquals(null, ObaflixCast.requestFor(fenixHttp, "T", null)) // never by default
    }

    @Test
    fun aUrlIsNotCompatibleJustBecauseItExists() {
        val cookieNeeded = src("https://cdn.example/a.mp4", headers = mapOf("Cookie" to "s=1"))
        val notReady = src("https://cdn.example/b.mp4", notWebReady = true)
        val torrent = src("magnet:?xt=urn:btih:abc")
        val noUrl = src(null)
        assertTrue(ranked(cookieNeeded, notReady, torrent, noUrl).candidates.isEmpty())
        // An https URL with no known extension is only a candidate: the reachability probe decides.
        val unknownFormat = src("https://cdn.example/watch?id=7")
        assertEquals(ObaflixCastPicker.Tier.UNKNOWN_CONTAINER, ranked(unknownFormat).candidates.single().tier)
        assertEquals(listOf(https720, unknownFormat), ranked(unknownFormat, https720).candidates.map { it.stream })
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
        obaflixAutoCast("obaflix:filme:5", "T", null, scope)(listOf(src(null), src("magnet:?xt=urn:btih:abc")))
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

    @Test
    fun aSourceThatDoesNotAnswerAsMediaIsSkippedAndTheNextOneIsHandedOver() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        ObaflixSourceProbe.check = { url, _ -> !url.contains("master.m3u8") }
        obaflixAutoCast("obaflix:filme:5", "T", null, scope)(listOf(https720, hls4k, https1080))
        scope.advanceUntilIdle()
        assertEquals(1, authorizeBodies.size) // one authorization (one ad), however many sources are tried
        assertEquals(listOf("https://cdn.b.example/v/1080.mp4?t=1"), handed.map { it.url })
    }

    @Test
    fun httpIsHandedOverOnlyWhenNoHttpsSourceWorks() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        ObaflixSourceProbe.check = { url, _ -> url.startsWith("http://") }
        obaflixAutoCast("obaflix:filme:5", "T", null, scope)(listOf(https720, fenixHttp))
        scope.advanceUntilIdle()
        assertEquals(listOf("http://fenixflix.fenixhub.online/r/x/video.mp4"), handed.map { it.url })
        handed.clear()
        ObaflixSourceProbe.check = { _, _ -> true }
        obaflixAutoCast("obaflix:filme:6", "T", null, scope)(listOf(fenixHttp, https720))
        scope.advanceUntilIdle()
        assertEquals(listOf("https://cdn.a.example/v/720.mp4"), handed.map { it.url }) // https wins when it works
    }

    @Test
    fun noReachableSourceHandsNothingOverAndAsksNoSecondAd() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        ObaflixSourceProbe.check = { _, _ -> false }
        obaflixAutoCast("obaflix:filme:5", "T", null, scope)(listOf(https720, fenixHttp))
        scope.advanceUntilIdle()
        assertTrue(handed.isEmpty())
        assertEquals(1, authorizeBodies.size)
    }
}
