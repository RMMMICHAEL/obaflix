package com.nuvio.app.integration.obaflix.ads

import java.util.concurrent.atomic.AtomicBoolean

internal enum class RewardedResult {
    /** onAdRewarded arrived (before the close, or within the grace window after it). */
    RECOMPENSADO,

    /** Closed and no onAdRewarded within the grace window. The server is still asked, briefly, before giving up. */
    FECHADO_SEM_RECOMPENSA,
    FALHA_EXIBICAO,
    INDISPONIVEL,
    TIMEOUT,
}

/**
 * One show attempt. The local reward comes only from [onRewarded]; [onClosed] never decides on its own that there was
 * none, because LevelPlay documents `onAdRewarded` and `onAdClosed` as asynchronous (the reward may come after the
 * close). With a scheduler, a close without reward opens a grace window of [gracaMs]: a reward inside it wins
 * ([RewardedResult.RECOMPENSADO]), otherwise the attempt ends as [RewardedResult.FECHADO_SEM_RECOMPENSA] and a later
 * reward is logged and dropped. Exactly one terminal result is delivered; duplicates are logged and dropped.
 *
 * Without a scheduler the grace is zero (tests of the plain state machine). Nothing here grants anything.
 */
internal class RewardedShowTracker(
    private val finish: (RewardedResult) -> Unit,
    private val log: (String) -> Unit = {},
    /** Runs the action after the delay and returns a function that cancels it. `null`: no grace window. */
    private val agendar: ((Long, () -> Unit) -> (() -> Unit))? = null,
    private val gracaMs: Long = GRACA_PADRAO_MS,
) {
    private val done = AtomicBoolean(false)
    private val rewarded = AtomicBoolean(false)
    private val aguardandoGraca = AtomicBoolean(false)
    @Volatile private var cancelarGraca: (() -> Unit)? = null

    /** True only for the first valid reward of this attempt. */
    fun onRewarded(): Boolean {
        if (done.get()) { log("reward_tardio_ignorado"); return false }
        if (!rewarded.compareAndSet(false, true)) { log("reward_duplicado_ignorado"); return false }
        log("reward_recebido")
        // The close already happened: this is the late reward the grace window waits for.
        if (aguardandoGraca.get()) end(RewardedResult.RECOMPENSADO)
        return true
    }

    fun onClosed() {
        if (done.get()) { log("terminal_duplicado_ignorado"); return }
        if (rewarded.get()) { end(RewardedResult.RECOMPENSADO); return }
        val agenda = agendar
        if (agenda == null) { end(RewardedResult.FECHADO_SEM_RECOMPENSA); return }
        if (!aguardandoGraca.compareAndSet(false, true)) { log("fechamento_repetido_ignorado"); return }
        log("fechado_sem_reward_ainda: aguardando ${gracaMs}ms")
        cancelarGraca = agenda(gracaMs) {
            if (rewarded.get()) end(RewardedResult.RECOMPENSADO) else end(RewardedResult.FECHADO_SEM_RECOMPENSA)
        }
        // A reward may have slipped in between the check and the scheduling.
        if (rewarded.get()) end(RewardedResult.RECOMPENSADO)
    }

    fun onDisplayFailed() = end(RewardedResult.FALHA_EXIBICAO)

    fun onTimeout() = end(RewardedResult.TIMEOUT)

    fun unavailable() = end(RewardedResult.INDISPONIVEL)

    private fun end(result: RewardedResult) {
        if (done.compareAndSet(false, true)) {
            cancelarGraca?.invoke()
            finish(result)
        } else {
            log("terminal_duplicado_ignorado")
        }
    }

    companion object {
        const val GRACA_PADRAO_MS = 3_000L
    }
}
