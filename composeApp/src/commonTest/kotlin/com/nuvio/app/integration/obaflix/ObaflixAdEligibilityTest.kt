package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.Instant

class ObaflixAdEligibilityTest {
    private val originalPost = ObaflixPlaybackGate.post
    private var shown = 0
    private var answer: (String) -> Pair<Int, String> = { 200 to """{"decisao":"PERMITIDO"}""" }

    private val movie = ObaflixRef("filme", "m1", null, null)

    @BeforeTest
    fun setUp() {
        ObaflixAdEligibility.reset()
        ObaflixPlaybackGate.clear()
        ObaflixPlaybackGate.clock = { Instant.fromEpochSeconds(1_800_000_000) }
        ObaflixPlaybackGate.post = { path, _ -> answer(path) }
        ObaflixPlaybackGate.adPresenter = ObaflixAdPresenter { shown++; true }
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
    }

    @AfterTest
    fun tearDown() {
        ObaflixPlaybackGate.post = originalPost
        ObaflixPlaybackGate.adPresenter = null
        ObaflixPlaybackGate.clock = { kotlin.time.Clock.System.now() }
        ObaflixPlaybackGate.clear()
        ObaflixSession.current = null
        ObaflixAdEligibility.reset()
    }

    @Test
    fun startsUnknownAndRestrictive() {
        assertEquals(ObaflixAdEligibility.State.UNKNOWN, ObaflixAdEligibility.state)
        assertFalse(ObaflixAdEligibility.allowsAds)
    }

    @Test
    fun onlyConfirmedEligibleAllowsAds() {
        ObaflixAdEligibility.confirm(true)
        assertTrue(ObaflixAdEligibility.allowsAds)
        ObaflixAdEligibility.confirm(false)
        assertFalse(ObaflixAdEligibility.allowsAds)
    }

    @Test
    fun exemptAccountStaysUnknown() = runTest {
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie))
        assertFalse(ObaflixAdEligibility.allowsAds)
        assertEquals(0, shown)
    }

    @Test
    fun serverAdObligationConfirmsContextualEligibility() = runTest {
        answer = { path ->
            if (path == "/api/ads/complete") 200 to """{"concessao":"c1"}"""
            else if (ObaflixAdEligibility.allowsAds) 200 to """{"decisao":"PERMITIDO","passe":"p1"}"""
            else 200 to """{"decisao":"ANUNCIO_NECESSARIO","desafioId":"d1"}"""
        }
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie))
        assertTrue(ObaflixAdEligibility.allowsAds)
        assertEquals(1, shown)
    }

    @Test
    fun exemptOrRefusedAccountNeverBecomesEligible() = runTest {
        answer = { 200 to """{"decisao":"NEGADO"}""" }
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
        assertFalse(ObaflixAdEligibility.allowsAds)
    }

    @Test
    fun failedAdNeverGrantsPlayback() = runTest {
        answer = { 200 to """{"decisao":"ANUNCIO_NECESSARIO","desafioId":"d1"}""" }
        ObaflixPlaybackGate.adPresenter = ObaflixAdPresenter { false } // SDK refused (e.g. not eligible/no fill)
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
    }

    @Test
    fun signOutResetsEligibility() {
        ObaflixAdEligibility.confirm(true)
        ObaflixSession.signOut()
        assertEquals(ObaflixAdEligibility.State.UNKNOWN, ObaflixAdEligibility.state)
    }
}
