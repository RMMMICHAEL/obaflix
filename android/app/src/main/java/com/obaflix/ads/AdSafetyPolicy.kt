package com.obaflix.ads

enum class AdFormat { INTERSTITIAL, REWARDED, BANNER, APP_OPEN }
enum class AdFailure { CONSENT_DENIED, INELIGIBLE, SDK_UNAVAILABLE, NO_INVENTORY, LOAD, SHOW, CANCELLED, TIMEOUT }

/** Restrictions local to the build, never overridden by remote switches. */
object AdSafetyPolicy {
    fun loadFailure(code: Int): AdFailure = if (code in setOf(509, 606, 1023, 1035)) AdFailure.NO_INVENTORY else AdFailure.LOAD
    fun allows(play: Boolean, format: AdFormat, enabled: Boolean, eligible: Boolean,
               consent: Boolean, fullscreen: Boolean, optIn: Boolean): Boolean =
        enabled && eligible && consent && !fullscreen &&
            !(play && (format == AdFormat.INTERSTITIAL || format == AdFormat.APP_OPEN)) &&
            (format != AdFormat.REWARDED || optIn)

    fun retryDelay(attempt: Int, jitter: Double): Long? {
        if (attempt !in 0..3) return null
        return ((1_000L shl attempt) * (0.75 + jitter.coerceIn(0.0, 1.0) * 0.5)).toLong()
    }
}

/** A hard local floor/cap remains effective even for malicious remote values. */
class AdSessionCap(private val now: () -> Long) {
    private var shown = 0
    private var lastShow: Long? = null
    fun available(remoteCap: Int, remoteIntervalMs: Long): Boolean =
        shown < remoteCap.coerceIn(0, 8) &&
            (lastShow == null || now() - lastShow!! >= remoteIntervalMs.coerceAtLeast(60_000))
    fun recordShow() { shown++; lastShow = now() }
}
