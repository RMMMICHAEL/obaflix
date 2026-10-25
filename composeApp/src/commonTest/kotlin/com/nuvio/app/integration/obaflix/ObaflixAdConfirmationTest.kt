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

/** The regular ad never opens by itself, and the public catalog never follows a Preview pin. */
class ObaflixAdConfirmationTest {
    private val originalPost = ObaflixPlaybackGate.post
    private val movie = ObaflixRef("filme", "m1", null, null)
    private var shown = 0
    private val asked = mutableListOf<Pair<String, Boolean>>()
    private var confirma = true
    private var completes = 0

    private class NoRewarded : ObaflixRewardedPresenter {
        override fun disponivel() = false
        override fun aquecer() {}
        override suspend fun escolher() = AdChoice.CANCELADO
        override suspend fun mostrar(desafioId: String) = RewardedAttempt.NAO_EXIBIDO
        override suspend fun consultar(desafioId: String) = RewardStatus.PENDENTE
    }

    @BeforeTest
    fun setUp() {
        ObaflixAdEligibility.reset()
        ObaflixPlaybackGate.clear()
        ObaflixPlaybackGate.clock = { Instant.fromEpochSeconds(1_800_000_000) }
        completes = 0
        ObaflixPlaybackGate.post = { path, _ ->
            if (path == "/api/ads/complete") { completes++; 200 to """{"concessao":"c1"}""" }
            else if (completes > 0) 200 to """{"decisao":"PERMITIDO","passe":"p1"}"""
            else 200 to """{"decisao":"ANUNCIO_NECESSARIO","desafioId":"d1"}"""
        }
        ObaflixPlaybackGate.adPresenter = object : ObaflixAdPresenter {
            override suspend fun show(): Boolean { shown++; return true }
            override suspend fun confirmar(finalidade: String, alternativaDoRewarded: Boolean): Boolean {
                asked += finalidade to alternativaDoRewarded
                return confirma
            }
        }
        ObaflixPlaybackGate.rewardedPresenter = null
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
    }

    @AfterTest
    fun tearDown() {
        ObaflixPlaybackGate.post = originalPost
        ObaflixPlaybackGate.adPresenter = null
        ObaflixPlaybackGate.rewardedPresenter = null
        ObaflixPlaybackGate.clock = { kotlin.time.Clock.System.now() }
        ObaflixPlaybackGate.clear()
        ObaflixSession.current = null
        ObaflixAdEligibility.reset()
        ObaflixConfig.restaurarProducao()
        ObaflixCatalogAddon.clearCache()
    }

    @Test
    fun theRegularAdAsksFirstAndOnlyOpensAfterTheUserConfirms() = runTest {
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie))
        assertEquals(listOf("reproducao" to false), asked)
        assertEquals(1, shown)
    }

    @Test
    fun decliningTheQuestionOpensNoAdAndGrantsNothing() = runTest {
        confirma = false
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
        assertEquals(0, shown)
        assertEquals(1, asked.size)
    }

    @Test
    fun downloadAndCastAskBeforeTheirAd() = runTest {
        for (finalidade in listOf(ObaflixPlaybackGate.DOWNLOAD, ObaflixPlaybackGate.TRANSMISSAO)) {
            ObaflixPlaybackGate.clear()
            asked.clear()
            completes = 0
            shown = 0
            confirma = false
            assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie, finalidade), finalidade)
            assertEquals(listOf(finalidade to false), asked)
            assertEquals(0, shown, finalidade)
        }
    }

    @Test
    fun anUnavailableRewardedOffersTheRegularAdAsAnIdentifiedAlternativeAfterANewConfirmation() = runTest {
        ObaflixPlaybackGate.rewardedPresenter = NoRewarded()
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie))
        assertEquals(listOf("reproducao" to true), asked) // alternativaDoRewarded = true
        assertEquals(1, shown)
        ObaflixPlaybackGate.clear()
        completes = 0
        shown = 0
        confirma = false
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
        assertEquals(0, shown, "never automatic")
    }

    @Test
    fun theCatalogStaysOnTheOfficialSiteWhilePreviewOnlyMovesTheSession() = runTest {
        assertTrue(ObaflixConfig.usarPreview("https://x-y.vercel.app"))
        assertEquals("https://x-y.vercel.app", ObaflixConfig.BASE_URL)
        assertEquals("https://obaflixbr.com", ObaflixConfig.CATALOG_BASE_URL)
        assertTrue(ObaflixConfig.catalogoSeparado)
        val urls = mutableListOf<String>()
        ObaflixCatalogAddon.fetch = { url -> urls += url; """{"imdbId":"tt0000001"}""" }
        ObaflixCatalogAddon.clearCache()
        assertEquals("tt0000001", ObaflixCatalogAddon.addonVideoId("obaflix:filme:1"))
        assertEquals(listOf("https://obaflixbr.com/api/filmes/1"), urls)
    }

    @Test
    fun withoutAPreviewTheTwoOriginsAreTheSameAndPersonalRowsStay() {
        assertEquals(ObaflixConfig.BASE_URL, ObaflixConfig.CATALOG_BASE_URL)
        assertFalse(ObaflixConfig.catalogoSeparado)
    }
}
