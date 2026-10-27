package com.nuvio.app.integration.obaflix

import com.nuvio.app.integration.obaflix.ads.RewardedPlaybackFlow
import com.nuvio.app.integration.obaflix.ads.RewardedResult
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class ObaflixRewardedFlowTest {
    private val pronto = ObaflixRewardedApi.Preparo.Pronto("b".repeat(48))
    private val ordem = mutableListOf<String>()
    private val esperas = mutableListOf<Long>()
    private var seguirAgora = true
    private var contaAgora = true

    private fun fluxo(
        carregado: Boolean = true,
        preparo: ObaflixRewardedApi.Preparo = pronto,
        definir: Boolean = true,
        resultado: RewardedResult = RewardedResult.RECOMPENSADO,
        respostas: List<Boolean?> = listOf(true),
        tentativas: Int = 4,
        verificacoes: Int = 3,
        aoExibir: () -> Unit = {},
        aoConsultar: () -> Unit = {},
    ): RewardedPlaybackFlow {
        val fila = respostas.toMutableList()
        return RewardedPlaybackFlow(
            aguardarPronto = { ordem += "aguardar"; carregado },
            seguir = { seguirAgora },
            mesmaConta = { contaAgora },
            preparar = { ordem += "preparar"; preparo },
            definirId = { ordem += "setDynamicUserId"; definir },
            exibir = { ordem += "showAd"; aoExibir(); resultado },
            confirmada = { ordem += "estado"; aoConsultar(); if (fila.isEmpty()) false else fila.removeAt(0) },
            cancelar = { ordem += "cancelar" },
            esperar = { esperas += it },
            tentativas = tentativas,
            intervaloMs = 1_000,
            tentativasVerificacao = verificacoes,
            intervaloVerificacaoMs = 500,
        )
    }

    @Test
    fun happyPathKeepsTheRequiredOrderAndNeverCancels() = runTest {
        assertEquals(RewardedAttempt.CONFIRMADA, fluxo().executar("d1"))
        assertEquals(listOf("aguardar", "preparar", "setDynamicUserId", "showAd", "estado"), ordem)
    }

    @Test
    fun theFirstAttemptWaitsForTheLoadBeforeReservingAnything() = runTest {
        assertEquals(RewardedAttempt.NAO_EXIBIDO, fluxo(carregado = false).executar("d1"))
        assertEquals(listOf("aguardar"), ordem, "nothing reserved on the server, nothing to cancel")
    }

    @Test
    fun confirmationMayArriveLateWithinThePolling() = runTest {
        assertEquals(RewardedAttempt.CONFIRMADA, fluxo(respostas = listOf(false, null, true)).executar("d1"))
        assertEquals(3, ordem.count { it == "estado" })
        assertEquals(listOf(1_000L, 1_000L), esperas)
    }

    @Test
    fun aSlowCallbackStaysPendingAndIsNeverCancelledNorGranted() = runTest {
        // the user watched to the end; the signed callback is slower than the whole polling window
        assertEquals(RewardedAttempt.PENDENTE, fluxo(respostas = emptyList(), tentativas = 4).executar("d1"))
        assertEquals(4, ordem.count { it == "estado" })
        assertEquals(3, esperas.size, "no wait after the last query")
        assertEquals("estado", ordem.last(), "a legitimate completion is not cancelled")
        assertEquals(false, "cancelar" in ordem)
    }

    @Test
    fun serverErrorsWhilePollingAlsoLeaveItPendingNotCancelled() = runTest {
        assertEquals(RewardedAttempt.PENDENTE, fluxo(respostas = listOf(false, null, false, null)).executar("d1"))
        assertEquals(false, "cancelar" in ordem)
    }

    @Test
    fun theUserStoppingTheWaitAfterWatchingKeepsItPending() = runTest {
        val r = fluxo(respostas = listOf(false, false, false), tentativas = 6, aoConsultar = { seguirAgora = false }).executar("d1")
        assertEquals(RewardedAttempt.PENDENTE, r)
        assertEquals(1, ordem.count { it == "estado" })
        assertEquals(false, "cancelar" in ordem)
    }

    @Test
    fun closedEarlyWithoutAnyRewardIsVerifiedBrieflyThenReleasesTheSlot() = runTest {
        val r = fluxo(resultado = RewardedResult.FECHADO_SEM_RECOMPENSA, respostas = emptyList(), verificacoes = 3).executar("d1")
        assertEquals(RewardedAttempt.NAO_CONFIRMADA, r)
        assertEquals(3, ordem.count { it == "estado" }, "bounded: three queries, no more")
        assertEquals(listOf(500L, 500L), esperas)
        assertEquals("cancelar", ordem.last())
    }

    @Test
    fun aRewardMissingLocallyButSignedByTheServerStillCompletes() = runTest {
        // onAdClosed fired and onAdRewarded never (or too late) arrived, yet LevelPlay's S2S event did: the server decides
        val r = fluxo(resultado = RewardedResult.FECHADO_SEM_RECOMPENSA, respostas = listOf(false, true)).executar("d1")
        assertEquals(RewardedAttempt.CONFIRMADA, r)
        assertEquals(false, "cancelar" in ordem, "a legitimate completion is never cancelled")
    }

    @Test
    fun stoppingOrSwitchingAccountDuringTheBriefVerificationReleasesTheSlotWithoutConfirming() = runTest {
        seguirAgora = false
        val a = fluxo(resultado = RewardedResult.FECHADO_SEM_RECOMPENSA, respostas = emptyList())
        // the user stopped waiting right after the ad closed
        assertEquals(RewardedAttempt.NAO_EXIBIDO, a.executar("d1"), "stopped before reserving")
        ordem.clear()
        seguirAgora = true
        val b = fluxo(resultado = RewardedResult.FECHADO_SEM_RECOMPENSA, respostas = emptyList(), aoExibir = { contaAgora = false })
        assertEquals(RewardedAttempt.NAO_CONFIRMADA, b.executar("d2"))
        assertEquals(0, ordem.count { it == "estado" }, "no query for the wrong account")
        assertEquals("cancelar", ordem.last())
    }

    @Test
    fun displayFailureAndTimeoutAfterReservingAreNotConfirmedAndNeverFallBack() = runTest {
        for (r in listOf(RewardedResult.FALHA_EXIBICAO, RewardedResult.TIMEOUT, RewardedResult.INDISPONIVEL)) {
            ordem.clear()
            assertEquals(RewardedAttempt.NAO_CONFIRMADA, fluxo(resultado = r).executar("d1"))
            assertEquals("cancelar", ordem.last())
            assertEquals(0, ordem.count { it == "estado" }, "the ad never showed: nothing to verify")
        }
    }

    @Test
    fun nothingIsShownWhenThePreparationFailsAndTheChallengeStaysFree() = runTest {
        for (p in listOf(ObaflixRewardedApi.Preparo.EmAndamento, ObaflixRewardedApi.Preparo.Indisponivel)) {
            ordem.clear()
            assertEquals(RewardedAttempt.NAO_EXIBIDO, fluxo(preparo = p).executar("d1"))
            assertEquals(listOf("aguardar", "preparar"), ordem)
        }
    }

    @Test
    fun aRefusedDynamicUserIdNeverShowsTheAdAndReleasesTheSlot() = runTest {
        assertEquals(RewardedAttempt.NAO_CONFIRMADA, fluxo(definir = false).executar("d1"))
        assertEquals(listOf("aguardar", "preparar", "setDynamicUserId", "cancelar"), ordem)
    }

    @Test
    fun userCancelOrAccountSwitchBeforeReservingStopsWithoutShowing() = runTest {
        seguirAgora = false
        assertEquals(RewardedAttempt.NAO_EXIBIDO, fluxo().executar("d1"))
        contaAgora = false
        seguirAgora = true
        assertEquals(RewardedAttempt.NAO_EXIBIDO, fluxo().executar("d1"))
        assertEquals(listOf("aguardar", "aguardar"), ordem, "nothing reserved")
    }

    @Test
    fun accountSwitchRightAfterReservingNeverShowsTheAd() = runTest {
        val f = RewardedPlaybackFlow(
            aguardarPronto = { true },
            seguir = { true },
            mesmaConta = { contaAgora },
            preparar = { ordem += "preparar"; contaAgora = false; pronto }, // the account changes right after reserving
            definirId = { ordem += "setDynamicUserId"; true },
            exibir = { ordem += "showAd"; RewardedResult.RECOMPENSADO },
            confirmada = { ordem += "estado"; true },
            cancelar = { ordem += "cancelar" },
            esperar = {},
        )
        assertEquals(RewardedAttempt.NAO_CONFIRMADA, f.executar("d1"))
        assertEquals(listOf("preparar", "setDynamicUserId", "cancelar"), ordem, "no ad for the wrong account")
    }

    @Test
    fun accountSwitchWhileWaitingForTheServerAbortsAndNeverClaimsForTheNewAccount() = runTest {
        val r = fluxo(respostas = listOf(false, false, false), tentativas = 6, aoConsultar = { contaAgora = false }).executar("d1")
        assertEquals(RewardedAttempt.NAO_CONFIRMADA, r)
        assertEquals(1, ordem.count { it == "estado" }, "stops asking as soon as the account changes")
        assertEquals("cancelar", ordem.last())
    }

    @Test
    fun theAdIsShownExactlyOncePerAttempt() = runTest {
        var exibicoes = 0
        fluxo(aoExibir = { exibicoes++ }).executar("d1")
        fluxo(aoExibir = { exibicoes++ }, respostas = emptyList()).executar("d2")
        assertEquals(2, exibicoes, "one show per attempt, even when confirmation is slow")
    }
}
