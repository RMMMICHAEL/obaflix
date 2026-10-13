package com.obaflix.ads
import org.json.JSONObject

data class RemoteAdSettings(val interstitial: Boolean = false, val rewarded: Boolean = false,
    val banner: Boolean = false, val sessionCap: Int = 0, val intervalMs: Long = 120_000) {
    companion object {
        fun parse(raw: String, play: Boolean): RemoteAdSettings = try {
            require(raw.length <= 2048)
            val value = JSONObject(raw)
            RemoteAdSettings(!play && value.optBoolean("interstitial", false), value.optBoolean("rewarded", false),
                value.optBoolean("banner", false), value.optInt("sessionCap", 0).coerceIn(0, 4),
                value.optLong("intervalSeconds", 120).coerceIn(120, 86400) * 1000)
        } catch (_: Exception) { RemoteAdSettings() }
    }
}
