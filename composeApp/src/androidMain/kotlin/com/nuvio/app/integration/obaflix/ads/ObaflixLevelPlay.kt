package com.nuvio.app.integration.obaflix.ads

import android.content.Context
import com.nuvio.app.integration.obaflix.ObaflixAdEligibility
import com.unity3d.mediation.LevelPlay
import com.unity3d.mediation.LevelPlayConfiguration
import com.unity3d.mediation.LevelPlayInitError
import com.unity3d.mediation.LevelPlayInitListener
import com.unity3d.mediation.LevelPlayInitRequest
import com.unity3d.mediation.LevelPlayPrivacySettings
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Single owner of the LevelPlay SDK (Banner today; Rewarded stays blocked, see [ObaflixAdsConfig]).
 *
 * Never initializes unless ads are confirmed for the account ([ObaflixAdEligibility]) and the build is
 * allowed ([ObaflixAdsConfig.levelPlayAllowed]). Privacy signals are set before `init`; if they cannot be
 * set the SDK stays off. `UnityAds.nonBehavioral` is NOT used here: it configures the direct SDK only.
 */
internal object ObaflixLevelPlay {
    private val started = AtomicBoolean(false)
    private val _ready = MutableStateFlow(false)

    val ready: StateFlow<Boolean> get() = _ready
    internal val initRequested: Boolean get() = started.get()

    /** The USER_ID LevelPlay was initialized with, or null when it was initialized without one. Fixed per process. */
    @Volatile internal var initUserId: String? = null
        private set

    /** The USER_ID the (possibly still running) init was requested with: null when requested without one. */
    @Volatile internal var requestedUserId: String? = null
        private set

    fun start(context: Context) {
        if (!ObaflixAdEligibility.allowsAds || !ObaflixAdsConfig.levelPlayAllowed(context)) return
        iniciar(context, null)
    }

    /**
     * Same gates as [start], plus the backend-issued USER_ID given to `withUserId` before init. LevelPlay initializes
     * once per process: if something started it first without an id, [initUserId] stays null and the S2S Rewarded
     * stays unavailable (it fails closed) until the next launch.
     */
    fun startComIdentidade(context: Context, lpUid: String) {
        if (!ObaflixAdEligibility.allowsAds || !ObaflixAdsConfig.levelPlayAllowed(context)) return
        iniciar(context, lpUid)
    }

    /** DEBUG-only (FLAG_DEBUGGABLE) entry for the Rewarded harness: no eligibility needed, a no-op in release. */
    fun startHomologacaoDebug(context: Context) {
        if (!ObaflixAdsConfig.isTestMode(context)) return
        // Must precede init; it only lets the dashboard test suite run, ads stay whatever the network serves.
        runCatching { LevelPlay.setMetaData("is_test_suite", "enable") }
        iniciar(context, null)
    }

    private fun iniciar(context: Context, lpUid: String?) {
        if (ObaflixAdsConfig.LEVELPLAY_APP_KEY.isBlank() || !started.compareAndSet(false, true)) return
        requestedUserId = lpUid
        // Contextual only: refuse GDPR consent and opt out of sale/sharing, before init. No legal basis is
        // implied by these signals, and COPPA is deliberately left to the Play audience decision.
        // The Unity adapter forwards: GDPR -> gdpr.consent, CCPA -> privacy.consent and the "UnityAds_coppa"
        // metadata -> user.nonBehavioral (read from the adapter bytecode). The last one is the contextual signal for
        // Unity traffic only; setCOPPA() would be a global child-directed declaration, so it is not used.
        val signaled = runCatching {
            LevelPlayPrivacySettings.setGDPRConsent(false)
            LevelPlayPrivacySettings.setCCPA(true)
            LevelPlay.setMetaData("UnityAds_coppa", "true")
        }.isSuccess
        if (!signaled) {
            started.set(false)
            ObaLog.alerta("ADS", "levelplay_privacy_error")
            return
        }
        runCatching {
            LevelPlay.init(
                context.applicationContext,
                LevelPlayInitRequest.Builder(ObaflixAdsConfig.LEVELPLAY_APP_KEY)
                    .also { if (lpUid != null) it.withUserId(lpUid) }
                    .build(),
                object : LevelPlayInitListener {
                    override fun onInitSuccess(configuration: LevelPlayConfiguration) {
                        initUserId = lpUid
                        _ready.value = true
                        ObaLog.evento("ADS", "levelplay_init_ok")
                    }

                    override fun onInitFailed(error: LevelPlayInitError) {
                        // No retry loop: a later eligible screen may try once more.
                        started.set(false)
                        ObaLog.alerta("ADS", "levelplay_init_error", "erro" to error.errorMessage)
                    }
                },
            )
        }.onFailure {
            started.set(false)
            ObaLog.alerta("ADS", "levelplay_init_error", "excecao" to it.javaClass.simpleName)
        }
    }
}
