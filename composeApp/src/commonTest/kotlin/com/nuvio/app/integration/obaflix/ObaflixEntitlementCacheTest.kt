package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant

class ObaflixEntitlementCacheTest {
    private var now = Instant.fromEpochSeconds(1_800_000_000)
    private var asks = 0
    private var adsShown = 0
    private var answer: (String) -> Pair<Int, String> = { 200 to """{"decisao":"PERMITIDO"}""" }
    private val originalPost = ObaflixPlaybackGate.post

    private fun movie(id: String) = ObaflixRef("filme", id, null, null)
    private fun login(userId: String) {
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), userId, "a@b.c")
    }

    @BeforeTest
    fun setUp() {
        ObaflixPlaybackGate.clear()
        ObaflixPlaybackGate.clock = { now }
        ObaflixPlaybackGate.post = { path, _ -> if (path == "/api/playback/authorize") asks++; answer(path) }
        ObaflixPlaybackGate.adPresenter = ObaflixAdPresenter { adsShown++; true }
        login("paid")
    }

    @AfterTest
    fun tearDown() {
        ObaflixPlaybackGate.post = originalPost
        ObaflixPlaybackGate.adPresenter = null
        ObaflixPlaybackGate.clock = { kotlin.time.Clock.System.now() }
        ObaflixPlaybackGate.clear()
        ObaflixSession.current = null
    }

    @Test
    fun serverExemptAccountIsAskedOncePerWindowAndNeverSeesAnAd() = runTest {
        repeat(3) { assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie("m$it"))) }
        assertEquals(1, asks)
        assertEquals(0, adsShown)
        assertNull(ObaflixPlaybackGate.takeToken(movie("m1"))) // exempt accounts carry no proof

        now += 6.minutes // window over: the server decides again (revocation takes effect)
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie("m9")))
        assertEquals(2, asks)
    }

    @Test
    fun revocationShowsUpAtTheNextAskWithinTheWindowOrAtRenew() = runTest {
        ObaflixPlaybackGate.authorize(movie("a"))
        answer = { 200 to """{"decisao":"ANUNCIO_NECESSARIO","desafioId":"d1"}""" }
        ObaflixPlaybackGate.renew(movie("b")) // /fontes refused: the exemption is dropped and the server asked again
        assertEquals(2, asks)
    }

    @Test
    fun accountSubjectToAdsIsAlwaysAskedPerTitleAndNeverExempt() = runTest {
        answer = { 200 to """{"decisao":"PERMITIDO","passe":"p1"}""" }
        repeat(3) { ObaflixPlaybackGate.authorize(movie("m$it")) }
        assertEquals(3, asks)
        assertEquals("p1", ObaflixPlaybackGate.takeToken(movie("m0")))
    }

    @Test
    fun refusalsAndAdChallengesNeverBecomeAnExemption() = runTest {
        answer = { 200 to """{"decisao":"ANUNCIO_INDISPONIVEL"}""" }
        ObaflixPlaybackGate.authorize(movie("x"))
        now += 11.seconds // past the 10 s refusal window only
        answer = { path -> if (path == "/api/ads/complete") 200 to """{"concessao":"c1"}""" else 200 to """{"decisao":"PERMITIDO","passe":"p2"}""" }
        ObaflixPlaybackGate.authorize(movie("y"))
        ObaflixPlaybackGate.authorize(movie("z"))
        assertEquals(3, asks) // x, y, z each asked: nothing was cached as exempt
    }

    @Test
    fun signOutAndAnotherAccountDoNotInheritTheExemption() = runTest {
        ObaflixPlaybackGate.authorize(movie("a"))
        login("other")
        ObaflixPlaybackGate.authorize(movie("b"))
        assertEquals(2, asks) // keyed by user

        login("paid")
        ObaflixSession.signOut()
        login("paid")
        ObaflixPlaybackGate.authorize(movie("c"))
        assertEquals(3, asks) // sign-out cleared it
    }
}
