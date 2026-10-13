package com.obaflix.ads

/** Session aggregates only: no account, challenge, auction, device or URLs. */
object AdMetrics {
    private val counts = mutableMapOf<String, Long>()
    private val revenueMicros = mutableMapOf<AdFormat, Long>()
    @Synchronized fun count(format: AdFormat, event: String) {
        if (event !in setOf("request", "load", "failure", "show", "completion", "cancel")) return
        val key = "${format.name}:$event"
        counts[key] = (counts[key] ?: 0) + 1
    }
    @Synchronized fun revenue(format: AdFormat, usd: Double?) {
        if (usd == null || !usd.isFinite() || usd < 0 || usd > 100) return
        revenueMicros[format] = (revenueMicros[format] ?: 0) + (usd * 1_000_000).toLong()
    }
    @Synchronized fun snapshot(): Map<String, Long> = counts.toMap() + revenueMicros.mapKeys { "${it.key.name}:revenue_usd_micros" }
}
