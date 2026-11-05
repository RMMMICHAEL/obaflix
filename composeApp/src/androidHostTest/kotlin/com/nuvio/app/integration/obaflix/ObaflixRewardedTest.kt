package com.nuvio.app.integration.obaflix

import android.app.Application
import com.nuvio.app.integration.obaflix.ads.LevelPlayRewardedAdProvider
import com.nuvio.app.integration.obaflix.ads.ObaflixLevelPlay
import com.nuvio.app.integration.obaflix.ads.ObaflixRewardedHomologacao
import com.nuvio.app.integration.obaflix.ads.RewardedResult
import com.nuvio.app.integration.obaflix.ads.RewardedShowTracker
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ObaflixRewardedTest {
    private fun tracker(results: MutableList<RewardedResult>, logs: MutableList<String> = mutableListOf()) =
        RewardedShowTracker({ results += it }, { logs += it })

    @Test
    fun rewardThenCloseIsTheOnlyRewardedResult() {
        val r = mutableListOf<RewardedResult>()
        val t = tracker(r)
        assertTrue(t.onRewarded())
        t.onClosed()
        assertEquals(listOf(RewardedResult.RECOMPENSADO), r)
    }

    @Test
    fun closeWithoutRewardIsNeverARewardEvenIfSkipped() {
        val r = mutableListOf<RewardedResult>()
        tracker(r).onClosed()
        assertEquals(listOf(RewardedResult.FECHADO_SEM_RECOMPENSA), r)
    }

    @Test
    fun duplicateRewardAndDuplicateTerminalCallbacksAreDropped() {
        val r = mutableListOf<RewardedResult>()
        val logs = mutableListOf<String>()
        val t = tracker(r, logs)
        assertTrue(t.onRewarded())
        assertFalse(t.onRewarded())
        t.onClosed()
        t.onClosed()
        t.onDisplayFailed()
        assertEquals(listOf(RewardedResult.RECOMPENSADO), r)
        assertTrue("reward_duplicado_ignorado" in logs && "terminal_duplicado_ignorado" in logs)
    }

    @Test
    fun lateRewardAfterCloseDoesNotGrant() {
        val r = mutableListOf<RewardedResult>()
        val t = tracker(r)
        t.onClosed()
        assertFalse(t.onRewarded())
        assertEquals(listOf(RewardedResult.FECHADO_SEM_RECOMPENSA), r)
    }

    @Test
    fun failureTimeoutAndUnavailableEndOnceWithoutReward() {
        for ((act, expected) in listOf<Pair<(RewardedShowTracker) -> Unit, RewardedResult>>(
            { t: RewardedShowTracker -> t.onDisplayFailed() } to RewardedResult.FALHA_EXIBICAO,
            { t: RewardedShowTracker -> t.onTimeout() } to RewardedResult.TIMEOUT,
            { t: RewardedShowTracker -> t.unavailable() } to RewardedResult.INDISPONIVEL,
        )) {
            val r = mutableListOf<RewardedResult>()
            val t = tracker(r)
            act(t)
            t.onClosed()
            assertEquals(listOf(expected), r)
        }
    }

    @Test
    fun providerNeverLoadsOrShowsWhenNotPermitted() {
        val logs = mutableListOf<String>()
        val provider = LevelPlayRewardedAdProvider(permitido = { false }, sdkPronto = { true }, log = { logs += it })
        provider.carregar()
        assertFalse(provider.pronto)
        val activity = Robolectric.buildActivity(android.app.Activity::class.java).create().get()
        val out = mutableListOf<RewardedResult>()
        provider.exibir(activity) { out += it }
        assertEquals(listOf(RewardedResult.INDISPONIVEL), out)
        assertTrue(logs.any { it.startsWith("load_bloqueado") })
    }

    @Test
    fun homologationDoorIsClosedInReleaseLikeBuilds() {
        val app = RuntimeEnvironment.getApplication()
        app.applicationInfo.flags = app.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE.inv()
        assertFalse(ObaflixRewardedHomologacao.disponivel(app))
        ObaflixRewardedHomologacao.iniciar(app)
        ObaflixRewardedHomologacao.carregar(app)
        ObaflixLevelPlay.startHomologacaoDebug(app)
        assertFalse(ObaflixLevelPlay.initRequested)
        assertTrue(ObaflixRewardedHomologacao.linhas.value.isEmpty())
    }
}

class ObaflixRewardedReloadPolicyTest {
    @Test
    fun retriesAreSpacedBoundedAndExhaust() {
        val p = com.nuvio.app.integration.obaflix.ads.RewardedReloadPolicy()
        assertEquals(5_000L, p.aposFalha(1))
        assertEquals(15_000L, p.aposFalha(2))
        assertEquals(45_000L, p.aposFalha(3))
        assertEquals(null, p.aposFalha(4)) // stops: no endless loop, the manual button resets it
        assertEquals(2_000L, p.aposExibicaoMs)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ObaflixRewardedAutoLoadTest {
    @Test
    fun autoLoadNeverRunsWhenNotPermittedAndNeverTouchesTheSdk() {
        val logs = mutableListOf<String>()
        val provider = LevelPlayRewardedAdProvider(permitido = { false }, sdkPronto = { true }, log = { logs += it })
        provider.ativar()
        org.robolectric.shadows.ShadowLooper.idleMainLooper(1, java.util.concurrent.TimeUnit.MINUTES)
        assertFalse(provider.pronto)
        assertTrue(logs.any { it.startsWith("auto_carga_bloqueada") })
        assertTrue(logs.none { it.startsWith("load_start") })
    }

    @Test
    fun waitsForLevelPlayWithBoundedPollingAndNeverShows() {
        val logs = mutableListOf<String>()
        var consultas = 0
        val provider = LevelPlayRewardedAdProvider(
            permitido = { true }, sdkPronto = { consultas++; false }, log = { logs += it },
        )
        provider.ativar()
        org.robolectric.shadows.ShadowLooper.idleMainLooper(5, java.util.concurrent.TimeUnit.MINUTES)
        assertTrue(consultas in 100..140) // 60 s of 0.5 s polls, then it stops by itself
        assertTrue(logs.any { it.startsWith("auto_carga_parada") })
        assertTrue(logs.none { it.startsWith("load_start") || it.startsWith("show_start") })
    }

    @Test
    fun deactivatingCancelsThePendingTick() {
        var consultas = 0
        val provider = LevelPlayRewardedAdProvider(permitido = { true }, sdkPronto = { consultas++; false })
        provider.ativar()
        provider.desativar()
        org.robolectric.shadows.ShadowLooper.idleMainLooper(1, java.util.concurrent.TimeUnit.MINUTES)
        assertEquals(0, consultas)
    }
}


/** onAdRewarded and onAdClosed are asynchronous: the tracker waits a grace window after a close without reward. */
class ObaflixRewardedGraceTest {
    private class Relogio {
        var tarefas = mutableListOf<Pair<Long, () -> Unit>>()
        var agora = 0L
        fun agendar(atraso: Long, acao: () -> Unit): () -> Unit {
            val t = (agora + atraso) to acao
            tarefas += t
            return { tarefas.remove(t) }
        }
        fun avancar(ms: Long) {
            agora += ms
            tarefas.filter { it.first <= agora }.also { tarefas.removeAll(it) }.forEach { it.second() }
        }
    }

    private fun tracker(relogio: Relogio, results: MutableList<RewardedResult>, logs: MutableList<String> = mutableListOf()) =
        RewardedShowTracker({ results += it }, { logs += it }, relogio::agendar, gracaMs = 3_000)

    @Test
    fun rewardArrivingAfterTheCloseWithinTheGraceStillRewards() {
        val rel = Relogio(); val r = mutableListOf<RewardedResult>()
        val t = tracker(rel, r)
        t.onClosed()
        assertTrue(r.isEmpty(), "the close alone decides nothing")
        rel.avancar(1_000)
        assertTrue(t.onRewarded())
        assertEquals(listOf(RewardedResult.RECOMPENSADO), r)
        rel.avancar(10_000)
        assertEquals(1, r.size, "the pending timer was cancelled: one terminal result")
    }

    @Test
    fun noRewardWithinTheGraceEndsAsClosedWithoutRewardAndALaterOneIsDropped() {
        val rel = Relogio(); val r = mutableListOf<RewardedResult>(); val logs = mutableListOf<String>()
        val t = tracker(rel, r, logs)
        t.onClosed()
        rel.avancar(3_000)
        assertEquals(listOf(RewardedResult.FECHADO_SEM_RECOMPENSA), r)
        assertFalse(t.onRewarded())
        assertTrue("reward_tardio_ignorado" in logs)
        assertEquals(1, r.size)
    }

    @Test
    fun rewardBeforeTheCloseEndsImmediatelyWithoutWaiting() {
        val rel = Relogio(); val r = mutableListOf<RewardedResult>()
        val t = tracker(rel, r)
        assertTrue(t.onRewarded())
        t.onClosed()
        assertEquals(listOf(RewardedResult.RECOMPENSADO), r)
        assertTrue(rel.tarefas.isEmpty(), "no grace timer needed")
    }

    @Test
    fun repeatedClosesAndRewardsProduceASingleResult() {
        val rel = Relogio(); val r = mutableListOf<RewardedResult>()
        val t = tracker(rel, r)
        t.onClosed(); t.onClosed(); t.onClosed()
        assertEquals(1, rel.tarefas.size, "one grace timer")
        t.onRewarded(); t.onRewarded()
        t.onClosed()
        rel.avancar(10_000)
        assertEquals(listOf(RewardedResult.RECOMPENSADO), r)
    }

    @Test
    fun aDisplayFailureDuringTheGraceEndsOnceAndCancelsTheTimer() {
        val rel = Relogio(); val r = mutableListOf<RewardedResult>()
        val t = tracker(rel, r)
        t.onClosed()
        t.onDisplayFailed()
        rel.avancar(10_000)
        assertEquals(listOf(RewardedResult.FALHA_EXIBICAO), r)
    }
}
