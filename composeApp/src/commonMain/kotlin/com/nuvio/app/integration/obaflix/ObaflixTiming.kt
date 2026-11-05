package com.nuvio.app.integration.obaflix

import co.touchlab.kermit.Logger
import kotlin.time.TimeSource

/**
 * Field measurement of "tap a native source -> first frame". Logs only (tag `ObaflixTiming`, no URLs, ids or tokens):
 * `adb logcat -s ObaflixTiming`. It changes no behavior and keeps no data beyond the current attempt.
 */
internal object ObaflixTiming {
    private val log = Logger.withTag("ObaflixTiming")

    @kotlin.concurrent.Volatile
    private var tap: TimeSource.Monotonic.ValueTimeMark? = null

    /** The user picked a native source. Starts the clock. */
    fun tap() {
        tap = TimeSource.Monotonic.markNow()
        log.i { "toque t=0ms" }
    }

    /** A named point of the current attempt, with the time since the tap (or "sem_toque" for auto-play / failover paths). */
    fun mark(name: String) {
        val since = tap?.elapsedNow()?.inWholeMilliseconds
        log.i { if (since != null) "$name t=${since}ms" else "$name sem_toque" }
    }

    /** First rendered frame ends the attempt. */
    fun firstFrame() {
        if (tap == null) return
        mark("primeiro_quadro")
        tap = null
    }

    fun step(name: String, ms: Long) {
        log.i { "$name dur=${ms}ms" }
    }

    inline fun <T> timed(name: String, block: () -> T): T {
        val start = TimeSource.Monotonic.markNow()
        try {
            return block()
        } finally {
            step(name, start.elapsedNow().inWholeMilliseconds)
        }
    }
}
