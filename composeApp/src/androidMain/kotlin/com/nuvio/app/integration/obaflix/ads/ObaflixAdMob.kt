package com.nuvio.app.integration.obaflix.ads

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.MobileAds
import com.google.android.gms.ads.RequestConfiguration
import com.google.android.ump.ConsentDebugSettings
import com.google.android.ump.ConsentInformation
import com.google.android.ump.ConsentRequestParameters
import com.google.android.ump.UserMessagingPlatform
import com.nuvio.app.integration.obaflix.ObaflixAdEligibility
import com.nuvio.app.integration.obaflix.ObaflixAdProviderChoice
import kotlin.coroutines.resume
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The only door to the AdMob SDK: the Play build, an eligible account, the server's choice and UMP consent must all agree
 * before anything is initialized or requested. Otherwise nothing here runs and Unity/LevelPlay stay in charge.
 *
 * One shared consent+init attempt at a time, kept alive past the caller's own wait: a UMP form the user is still reading
 * is never cut short by a caller that gave up, and a second caller joins it instead of starting another request.
 */
internal object ObaflixAdMob {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    @Volatile private var inicializado = false
    private var emAndamento: Deferred<Boolean>? = null

    /** Manifest switch set only in the Play flavor: every other build never selects AdMob, whatever the server says. */
    fun noBuild(context: Context): Boolean = runCatching {
        val app = context.applicationContext ?: context
        val meta = app.packageManager.getApplicationInfo(app.packageName, PackageManager.GET_META_DATA).metaData
        meta?.get("obaflix.admob_enabled").let { it == true || it == "true" }
    }.getOrDefault(false)

    fun interstitialSelecionado(context: Context): Boolean =
        noBuild(context) && ObaflixAdEligibility.allowsAds && ObaflixAdProviderChoice.choice().interstitialAdmob

    fun rewardedSelecionado(context: Context): Boolean =
        noBuild(context) && ObaflixAdEligibility.allowsAds && ObaflixAdProviderChoice.choice().rewardedAdmob

    fun interstitialUnit(context: Context): String =
        if (ObaflixAdsConfig.isTestMode(context)) ObaflixAdsConfig.ADMOB_TEST_INTERSTITIAL_UNIT_ID else ObaflixAdsConfig.ADMOB_INTERSTITIAL_UNIT_ID

    fun rewardedUnit(context: Context): String =
        if (ObaflixAdsConfig.isTestMode(context)) ObaflixAdsConfig.ADMOB_TEST_REWARDED_UNIT_ID else ObaflixAdsConfig.ADMOB_REWARDED_UNIT_ID

    /** True once consent allows ad requests and the SDK is initialized; false on any failure or after [limiteMs]. */
    suspend fun aguardar(activity: Activity, limiteMs: Long = ESPERA_PADRAO_MS): Boolean {
        val tentativa = iniciar(activity) ?: return false
        return withTimeoutOrNull(limiteMs) { tentativa.await() } ?: false
    }

    /** The shared consent+init attempt (started if none is running), or null outside the AdMob build. Lets a caller stop waiting early. */
    fun iniciar(activity: Activity): Deferred<Boolean>? {
        if (!noBuild(activity)) return null
        return synchronized(this) {
            emAndamento?.takeIf { it.isActive } ?: scope.async { preparar(activity) }.also { emAndamento = it }
        }
    }

    private suspend fun preparar(activity: Activity): Boolean {
        val ok = withTimeoutOrNull(CONSENTIMENTO_MAX_MS) { consentir(activity) } ?: false
        if (!ok) return false
        if (inicializado) return true
        val pronto = CompletableDeferred<Unit>()
        if (ObaflixAdsConfig.isTestMode(activity)) {
            MobileAds.setRequestConfiguration(
                RequestConfiguration.Builder().setTestDeviceIds(listOf(AdRequest.DEVICE_ID_EMULATOR)).build(),
            )
        }
        MobileAds.initialize(activity.applicationContext) { pronto.complete(Unit) }
        // The SDK always answers; the cap only keeps a broken init from holding the shared attempt forever.
        if (withTimeoutOrNull(INIT_MAX_MS) { pronto.await() } == null) return false
        inicializado = true
        return true
    }

    /** UMP: refresh the consent state, show the form only if Google requires it, then ask whether ads may be requested. */
    private suspend fun consentir(activity: Activity): Boolean = suspendCancellableCoroutine { cont ->
        val info = UserMessagingPlatform.getConsentInformation(activity)
        fun terminar() { if (cont.isActive) cont.resume(info.canRequestAds()) }
        info.requestConsentInfoUpdate(
            activity,
            parametrosDeConsentimento(activity),
            { UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity) { terminar() } },
            { terminar() }, // offline: the stored consent (if any) still decides
        )
    }

    // Debug builds only (see [aplicarDepuracao]): force the EEA form and/or name a test device, so UMP can be exercised from anywhere.
    @Volatile private var depuracaoEea = false
    @Volatile private var depuracaoDispositivo: String? = null

    private fun parametrosDeConsentimento(activity: Activity): ConsentRequestParameters {
        val builder = ConsentRequestParameters.Builder()
        if (ObaflixAdsConfig.isTestMode(activity) && (depuracaoEea || depuracaoDispositivo != null)) {
            val debug = ConsentDebugSettings.Builder(activity)
            if (depuracaoEea) debug.setDebugGeography(ConsentDebugSettings.DebugGeography.DEBUG_GEOGRAPHY_EEA)
            depuracaoDispositivo?.let { debug.addTestDeviceHashedId(it) }
            builder.setConsentDebugSettings(debug.build())
        }
        return builder.build()
    }

    /**
     * Debuggable builds only; ignored in release. Launch extras: `obaflix_ump_eea` (force the EEA consent form),
     * `obaflix_ump_device` (the hashed id UMP prints in Logcat), `obaflix_ump_reset` (forget the stored consent).
     */
    fun aplicarDepuracao(activity: Activity, intent: android.content.Intent?) {
        if (!ObaflixAdsConfig.isTestMode(activity) || intent == null) return
        depuracaoEea = intent.getBooleanExtra("obaflix_ump_eea", depuracaoEea)
        depuracaoDispositivo = intent.getStringExtra("obaflix_ump_device")?.takeIf { it.isNotBlank() } ?: depuracaoDispositivo
        if (intent.getBooleanExtra("obaflix_ump_reset", false)) UserMessagingPlatform.getConsentInformation(activity).reset()
    }

    /** Settings entry: shown only when the consent form says the user must be able to reopen it. */
    fun privacidadeNecessaria(context: Context): Boolean =
        noBuild(context) &&
            UserMessagingPlatform.getConsentInformation(context).privacyOptionsRequirementStatus ==
            ConsentInformation.PrivacyOptionsRequirementStatus.REQUIRED

    fun mostrarPrivacidade(activity: Activity) {
        UserMessagingPlatform.showPrivacyOptionsForm(activity) { }
    }

    private const val ESPERA_PADRAO_MS = 15_000L
    private const val CONSENTIMENTO_MAX_MS = 120_000L
    private const val INIT_MAX_MS = 10_000L
}
