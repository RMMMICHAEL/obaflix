package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.addons.RawHttpResponse
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.Instant

class ObaflixRewardedGateTest {
    private val originalPost = ObaflixPlaybackGate.post
    private var interstitials = 0
    private var completes = 0
    private var answer: (String) -> Pair<Int, String> = { 200 to "{}" }
    private val movie = ObaflixRef("filme", "m1", null, null)

    private class Rewarded(
        var disponivel: Boolean = true,
        var escolha: AdChoice = AdChoice.REWARDED,
        var resultado: RewardedAttempt = RewardedAttempt.CONFIRMADA,
        var falhaNaEscolha: Boolean = false,
        var falhaNoShow: Boolean = false,
        var status: RewardStatus = RewardStatus.PENDENTE,
        var falhaNaConsulta: Boolean = false,
    ) : ObaflixRewardedPresenter {
        var consultas = 0
        var warmups = 0
        var perguntas = 0
        val shown = mutableListOf<String>()
        override fun disponivel() = disponivel
        override fun aquecer() { warmups++ }
        override suspend fun escolher(): AdChoice {
            perguntas++
            if (falhaNaEscolha) error("boom")
            return escolha
        }
        override suspend fun consultar(desafioId: String): RewardStatus {
            consultas++
            if (falhaNaConsulta) error("rede")
            return status
        }
        override suspend fun mostrar(desafioId: String): RewardedAttempt {
            shown += desafioId
            if (falhaNoShow) error("boom")
            return resultado
        }
    }

    @BeforeTest
    fun setUp() {
        ObaflixAdEligibility.reset()
        ObaflixPlaybackGate.clear()
        ObaflixPlaybackGate.clock = { Instant.fromEpochSeconds(1_800_000_000) }
        ObaflixPlaybackGate.post = { path, _ ->
            if (path == "/api/ads/complete") completes++
            answer(path)
        }
        ObaflixPlaybackGate.adPresenter = ObaflixAdPresenter { interstitials++; true }
        ObaflixPlaybackGate.rewardedPresenter = null
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
        answer = { path ->
            when {
                path == "/api/ads/complete" -> 200 to """{"concessao":"c1"}"""
                completes > 0 -> 200 to """{"decisao":"PERMITIDO","passe":"p1"}"""
                else -> 200 to """{"decisao":"ANUNCIO_NECESSARIO","desafioId":"d1"}"""
            }
        }
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
    }

    @Test
    fun explicitChoiceOfTheRewardedConfirmedByTheServerOpensPlaybackWithoutAnInterstitial() = runTest {
        val r = Rewarded().also { ObaflixPlaybackGate.rewardedPresenter = it }
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie))
        assertEquals(1, r.perguntas)
        assertEquals(listOf("d1"), r.shown)
        assertEquals(0, interstitials, "one ad per action")
        assertEquals(1, completes)
        assertEquals("p1", ObaflixPlaybackGate.takeToken(movie))
    }

    @Test
    fun choosingTheRegularAdKeepsTheExistingInterstitialFlowAndNeverShowsTheRewarded() = runTest {
        val r = Rewarded(escolha = AdChoice.INTERSTITIAL).also { ObaflixPlaybackGate.rewardedPresenter = it }
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie))
        assertEquals(1, interstitials)
        assertTrue(r.shown.isEmpty())
    }

    @Test
    fun cancellingTheChoiceShowsNoAdAndGrantsNothing() = runTest {
        ObaflixPlaybackGate.rewardedPresenter = Rewarded(escolha = AdChoice.CANCELADO)
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
        assertEquals(0, interstitials)
        assertEquals(0, completes)
    }

    @Test
    fun aRewardedThatDidNotShowBlocksAndDoesNotSilentlySubstituteAnInterstitial() = runTest {
        val r = Rewarded(resultado = RewardedAttempt.NAO_EXIBIDO).also { ObaflixPlaybackGate.rewardedPresenter = it }
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
        assertEquals(1, r.shown.size)
        assertEquals(0, interstitials, "the user chose the Rewarded: never a second, different ad")
        assertEquals(0, completes)
    }

    @Test
    fun unconfirmedRewardedBlocksAndNeverFollowsWithAnInterstitialOrAGrant() = runTest {
        ObaflixPlaybackGate.rewardedPresenter = Rewarded(resultado = RewardedAttempt.NAO_CONFIRMADA)
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
        assertEquals(0, interstitials)
        assertEquals(0, completes, "no /api/ads/complete without the server's confirmation")
    }

    @Test
    fun crashesInTheChoiceOrInTheRewardedBlockInsteadOfGranting() = runTest {
        ObaflixPlaybackGate.rewardedPresenter = Rewarded(falhaNaEscolha = true)
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
        ObaflixPlaybackGate.clear()
        ObaflixPlaybackGate.rewardedPresenter = Rewarded(falhaNoShow = true)
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
        assertEquals(0, interstitials)
        assertEquals(0, completes)
    }

    @Test
    fun whenTheRewardedCannotBeOfferedThereIsNoQuestionAndTheInterstitialRunsAsBefore() = runTest {
        val r = Rewarded(disponivel = false).also { ObaflixPlaybackGate.rewardedPresenter = it }
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie))
        assertEquals(0, r.perguntas)
        assertEquals(emptyList(), r.shown)
        assertEquals(1, interstitials)
        assertEquals(1, r.warmups, "warm-up starts once the server asked for an ad")
    }

    @Test
    fun exemptAccountNeverTouchesAnyPresenter() = runTest {
        answer = { 200 to """{"decisao":"PERMITIDO"}""" }
        val r = Rewarded().also { ObaflixPlaybackGate.rewardedPresenter = it }
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie))
        assertEquals(0, r.warmups)
        assertEquals(0, r.perguntas)
        assertTrue(r.shown.isEmpty())
        assertEquals(0, interstitials)
        assertFalse(ObaflixAdEligibility.allowsAds)
    }

    @Test
    fun downloadAndCastNeverOfferTheRewardedAndKeepTheInterstitialFlow() = runTest {
        for (finalidade in listOf(ObaflixPlaybackGate.DOWNLOAD, ObaflixPlaybackGate.TRANSMISSAO)) {
            ObaflixPlaybackGate.clear()
            completes = 0
            interstitials = 0
            val r = Rewarded().also { ObaflixPlaybackGate.rewardedPresenter = it }
            assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie, finalidade), finalidade)
            assertEquals(0, r.perguntas, "no dialog for $finalidade")
            assertTrue(r.shown.isEmpty(), "no Rewarded for $finalidade")
            assertEquals(0, r.warmups, "no warm-up for $finalidade")
            assertEquals(1, interstitials, "the existing Interstitial serves $finalidade")
            assertEquals(1, completes)
        }
    }

    @Test
    fun aPlaybackRewardDoesNotInterfereWithALaterDownloadOrCast() = runTest {
        val r = Rewarded().also { ObaflixPlaybackGate.rewardedPresenter = it }
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie)) // playback via Rewarded
        assertEquals(1, r.shown.size)
        avancar(120)
        completes = 0
        for (finalidade in listOf(ObaflixPlaybackGate.DOWNLOAD, ObaflixPlaybackGate.TRANSMISSAO)) {
            completes = 0
            assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie, finalidade), finalidade)
        }
        assertEquals(1, r.shown.size, "the Rewarded was used once, for playback only")
        assertEquals(1, r.perguntas)
    }

    @Test
    fun theGrantRequestSurvivesTheCallerBeingCancelledRightAfterTheServerConfirmation() = runTest {
        // after the full-screen ad the Activity is recreated and the UI coroutine is cancelled: the reward was already
        // confirmed, so /api/ads/complete must still go out, otherwise the user watched the ad for nothing
        val r = object : ObaflixRewardedPresenter {
            override fun disponivel() = true
            override fun aquecer() {}
            override suspend fun escolher() = AdChoice.REWARDED
            override suspend fun consultar(desafioId: String) = RewardStatus.PENDENTE
            override suspend fun mostrar(desafioId: String): RewardedAttempt {
                kotlin.coroutines.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
                return RewardedAttempt.CONFIRMADA
            }
        }
        ObaflixPlaybackGate.rewardedPresenter = r
        // the gate runs in its own child coroutine (like the UI scope), so only that one is cancelled
        val ui = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Job() + kotlinx.coroutines.Dispatchers.Unconfined).launch {
            ObaflixPlaybackGate.authorize(movie)
        }
        ui.join()
        assertEquals(1, completes, "the confirmed reward is never dropped")
        assertEquals(0, interstitials)
    }

    private fun avancar(segundos: Long) {
        val base = Instant.fromEpochSeconds(1_800_000_000 + segundos)
        ObaflixPlaybackGate.clock = { base }
    }

    @Test
    fun aSlowCallbackLeavesItPendingThenAConfirmationLaterOpensPlaybackWithoutANewAd() = runTest {
        val r = Rewarded(resultado = RewardedAttempt.PENDENTE).also { ObaflixPlaybackGate.rewardedPresenter = it }
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
        assertEquals(0, completes, "nothing is released while the server has not confirmed")
        assertEquals(0, interstitials)

        avancar(60)
        r.status = RewardStatus.PENDENTE // still waiting: no new dialog, no new ad
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
        assertEquals(1, r.perguntas)
        assertEquals(1, r.shown.size)
        assertEquals(0, completes)

        avancar(120)
        r.status = RewardStatus.CONFIRMADA // the signed callback finally arrived
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie))
        assertEquals(1, completes, "the same /api/ads/complete, once")
        assertEquals(1, r.perguntas, "no second question")
        assertEquals(1, r.shown.size, "no second ad")
        assertEquals("p1", ObaflixPlaybackGate.takeToken(movie))
    }

    @Test
    fun aPendingRewardThatExpiredStartsTheNormalFlowAgain() = runTest {
        val r = Rewarded(resultado = RewardedAttempt.PENDENTE).also { ObaflixPlaybackGate.rewardedPresenter = it }
        ObaflixPlaybackGate.authorize(movie)
        avancar(60)
        r.status = RewardStatus.EXPIRADA
        r.resultado = RewardedAttempt.CONFIRMADA
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie))
        assertEquals(2, r.perguntas, "the user is asked again")
    }

    @Test
    fun aFailedQueryNeverDropsNorGrantsAPendingReward() = runTest {
        val r = Rewarded(resultado = RewardedAttempt.PENDENTE, falhaNaConsulta = true).also { ObaflixPlaybackGate.rewardedPresenter = it }
        ObaflixPlaybackGate.authorize(movie)
        avancar(60)
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movie))
        assertEquals(0, completes)
        assertEquals(1, r.perguntas)
    }

    @Test
    fun aPendingRewardNeverBlocksOtherTitlesAndSignOutForgetsIt() = runTest {
        val r = Rewarded(resultado = RewardedAttempt.PENDENTE).also { ObaflixPlaybackGate.rewardedPresenter = it }
        ObaflixPlaybackGate.authorize(movie)
        avancar(60)
        val outro = ObaflixRef("filme", "m2", null, null)
        r.resultado = RewardedAttempt.CONFIRMADA
        answer = { path ->
            when {
                path == "/api/ads/complete" -> 200 to """{"concessao":"c9"}"""
                completes > 0 -> 200 to """{"decisao":"PERMITIDO","passe":"p9"}"""
                else -> 200 to """{"decisao":"ANUNCIO_NECESSARIO","desafioId":"d2"}"""
            }
        }
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(outro), "the other title follows its own flow")
        ObaflixSession.signOut()
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
        val consultasAntes = r.consultas
        avancar(300)
        ObaflixPlaybackGate.authorize(movie)
        assertEquals(consultasAntes, r.consultas, "after sign-out nothing is left to resume")
    }

    @Test
    fun noRewardedPresenterMeansTheExistingBehaviour() = runTest {
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movie))
        assertEquals(1, interstitials)
    }
}

class ObaflixRewardedApiTest {
    private val original = ObaflixSession.http
    private val calls = mutableListOf<Pair<String, String>>()

    @BeforeTest
    fun setUp() {
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
    }

    @AfterTest
    fun tearDown() {
        ObaflixSession.http = original
        ObaflixSession.current = null
    }

    private fun backend(status: Int, body: String) {
        ObaflixSession.http = { method, url, _, _ ->
            calls += method to url
            RawHttpResponse(status, "", url, body, emptyMap())
        }
    }

    @Test
    fun identityIsAcceptedOnlyInTheExpectedShape() = runTest {
        backend(200, """{"userId":"${"a".repeat(32)}"}""")
        assertEquals("a".repeat(32), ObaflixRewardedApi.identidade())
        backend(200, """{"userId":"conta@exemplo.com"}""")
        assertEquals(null, ObaflixRewardedApi.identidade())
        backend(404, "{}")
        assertEquals(null, ObaflixRewardedApi.identidade())
    }

    @Test
    fun prepareDistinguishesReadyBusyAndUnavailable() = runTest {
        backend(200, """{"dynamicUserId":"${"b".repeat(48)}"}""")
        assertEquals(ObaflixRewardedApi.Preparo.Pronto("b".repeat(48)), ObaflixRewardedApi.preparar("d1"))
        backend(409, """{"codigo":"recompensa_em_andamento"}""")
        assertEquals(ObaflixRewardedApi.Preparo.EmAndamento, ObaflixRewardedApi.preparar("d1"))
        backend(200, """{"dynamicUserId":"curto"}""")
        assertEquals(ObaflixRewardedApi.Preparo.Indisponivel, ObaflixRewardedApi.preparar("d1"))
        backend(503, "{}")
        assertEquals(ObaflixRewardedApi.Preparo.Indisponivel, ObaflixRewardedApi.preparar("d1"))
        ObaflixSession.http = { _, _, _, _ -> throw RuntimeException("sem rede") }
        assertEquals(ObaflixRewardedApi.Preparo.Indisponivel, ObaflixRewardedApi.preparar("d1"))
    }

    @Test
    fun confirmationIsTrueOnlyWhenTheServerSaysSo() = runTest {
        backend(200, """{"preparado":true,"confirmada":true}""")
        assertEquals(true, ObaflixRewardedApi.confirmada("d1"))
        backend(200, """{"preparado":true,"confirmada":false}""")
        assertEquals(false, ObaflixRewardedApi.confirmada("d1"))
        backend(200, "nao e json")
        assertEquals(null, ObaflixRewardedApi.confirmada("d1"))
        backend(404, "{}")
        assertEquals(null, ObaflixRewardedApi.confirmada("d1"))
        assertTrue(calls.any { it.second.endsWith("/api/ads/levelplay/estado?desafioId=d1") })
    }

    @Test
    fun cancelIsBestEffortAndNeverThrows() = runTest {
        backend(200, """{"cancelada":true}""")
        ObaflixRewardedApi.cancelar("d1")
        assertTrue(calls.any { it.first == "POST" && it.second.endsWith("/api/ads/levelplay/cancelar") })
        ObaflixSession.http = { _, _, _, _ -> throw RuntimeException("sem rede") }
        ObaflixRewardedApi.cancelar("d1") // no exception: the slot just expires on its own
    }
}
