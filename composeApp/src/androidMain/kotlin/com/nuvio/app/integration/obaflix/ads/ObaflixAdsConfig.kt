package com.nuvio.app.integration.obaflix.ads

import co.touchlab.kermit.Logger

/** Same public Unity panel ids as the official app (android/app/build.gradle); not secrets. */
internal object ObaflixAdsConfig {
    const val UNITY_ADS_GAME_ID = "800367180"
    const val UNITY_ADS_PLACEMENT_ID = "Interstitial_Android"

    // Unity LevelPlay (mediation). Public dashboard ids, not secrets.
    const val LEVELPLAY_APP_KEY = "28ae06ef5"
    const val LEVELPLAY_BANNER_UNIT_ID = "pcvndqhb9jyg4sla"

    /** Banners stay permanently off: the slot renders nothing and never starts LevelPlay. */
    const val BANNER_ENABLED = false
    // Interstitial stays on the direct SDK above until its replacement is validated; id kept for that step.
    const val LEVELPLAY_INTERSTITIAL_UNIT_ID = "91rnm2fwujdtll7a"
    const val LEVELPLAY_REWARDED_DIRECT_UNIT_ID = "kwvfiubwy3e39f2y"
    const val LEVELPLAY_REWARDED_PLAY_UNIT_ID = "s1wluycthes8kcij"

    /** Interstitial still runs on the direct Unity SDK; flip only after the LevelPlay one is validated on device. */
    const val INTERSTITIAL_VIA_LEVELPLAY = false

    /** Release stays off until homologation; debuggable builds always allowed. */
    const val LEVELPLAY_RELEASE_APPROVED = false

    /**
     * Rewarded grants playback/download/cast, so it needs proof the server can verify (S2S callback or a
     * format-aware /api/ads/complete). Neither exists yet; nothing may flip this on without them.
     */
    const val REWARDED_ENABLED = false

    /**
     * Voluntary Rewarded that opens the player (S2S-confirmed). Off: with it false the app behaves exactly as before.
     * The backend flags (ANUNCIO_REWARDED_PLAYER_ATIVO, LEVELPLAY_S2S_RECEIVER_ENABLED) must also be on.
     */
    const val REWARDED_PLAYER_ENABLED = false

    /** Homologation switch: the S2S Rewarded may run in DEBUG builds only, and only against a pinned Preview backend. */
    const val REWARDED_PLAYER_DEBUG = true

    /**
     * Release opt-in baked into the manifest by `-PobaflixRewardedRelease=true` (default "false"). Read once per process.
     * It never replaces the server side: with the backend flags off no ad is ever requested.
     */
    @Volatile private var releaseOptIn: Boolean? = null

    internal fun rewardedReleaseOptIn(context: android.content.Context): Boolean =
        releaseOptIn ?: runCatching {
            val app = context.applicationContext ?: context
            app.packageManager.getApplicationInfo(app.packageName, android.content.pm.PackageManager.GET_META_DATA)
                .metaData?.get("obaflix.rewarded_release").isOptInValue()
        }.getOrDefault(false).also { releaseOptIn = it }

    /** aapt types a "true" placeholder as a Boolean, and `Bundle.getString` returns null for it: accept both forms. */
    internal fun Any?.isOptInValue(): Boolean = this == true || this == "true"

    fun rewardedPlayerEnabled(context: android.content.Context): Boolean =
        rewardedPlayerEnabled(context.applicationInfo.flags, releaseOptIn = rewardedReleaseOptIn(context))

    internal fun rewardedPlayerEnabled(
        applicationFlags: Int,
        previewPinned: Boolean = com.nuvio.app.integration.obaflix.ObaflixConfig.usandoPreview,
        releaseOptIn: Boolean = false,
    ): Boolean =
        REWARDED_PLAYER_ENABLED || releaseOptIn || (REWARDED_PLAYER_DEBUG && isTestMode(applicationFlags) && previewPinned)

    fun levelPlayAllowed(context: android.content.Context): Boolean =
        levelPlayAllowed(context.applicationInfo.flags) || rewardedReleaseOptIn(context)

    internal fun levelPlayAllowed(applicationFlags: Int): Boolean =
        isTestMode(applicationFlags) || LEVELPLAY_RELEASE_APPROVED

    /** Debuggable builds (debug) only ever request Unity test ads; release builds request real ones. */
    fun isTestMode(context: android.content.Context): Boolean = isTestMode(context.applicationInfo.flags)

    internal fun isTestMode(applicationFlags: Int): Boolean =
        applicationFlags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0
}

/** Log shim with the official `ObaLog` signatures, so the copied provider stays unchanged. */
internal object ObaLog {
    private val log = Logger.withTag("ObaflixAds")

    fun evento(fase: String, nome: String, vararg dados: Pair<String, Any?>) {
        log.i { "$fase $nome ${dados.joinToString { "${it.first}=${it.second}" }}" }
    }

    fun alerta(fase: String, nome: String, vararg dados: Pair<String, Any?>) {
        log.w { "$fase $nome ${dados.joinToString { "${it.first}=${it.second}" }}" }
    }
}
