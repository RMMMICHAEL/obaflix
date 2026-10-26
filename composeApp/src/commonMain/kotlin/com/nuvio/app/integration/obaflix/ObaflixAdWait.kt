package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow

/**
 * Network budget for [block] that does not run while a full-screen ad is on screen or being confirmed
 * ([ObaflixPlaybackGate.anuncioEmCurso]): the ad is the user's time, not the network's. Null when the budget ran out, so
 * a source search that never answers still ends. Ad time itself is not capped here (the user closes it; the server
 * confirmation has its own bounded wait).
 */
internal suspend fun <T> withNetworkBudget(
    budgetMs: Long,
    adActive: StateFlow<Boolean> = ObaflixPlaybackGate.anuncioEmCurso,
    stepMs: Long = 250L,
    block: suspend () -> T,
): T? = coroutineScope {
    val job = async { block() }
    var left = budgetMs
    while (job.isActive) {
        delay(stepMs)
        if (!adActive.value) left -= stepMs
        if (left <= 0 && job.isActive) {
            job.cancel()
            return@coroutineScope null
        }
    }
    job.await()
}

/**
 * Who may cancel a Rewarded in progress. The user can always (Cancel button / back). Losing the Activity cancels only
 * before the ad is on screen: afterwards it is routinely recreated (it was, on the S9+) and the wait for the server's
 * confirmation must go on.
 */
internal class RewardedCancellation {
    @kotlin.concurrent.Volatile private var cancelled = false
    @kotlin.concurrent.Volatile private var shown = false

    val isCancelled: Boolean get() = cancelled

    fun userCancelled() {
        cancelled = true
    }

    fun adShown() {
        shown = true
    }

    fun activityDestroyed() {
        if (!shown) cancelled = true
    }
}
