package com.obaflix.ads

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.obaflix.BuildConfig
import com.obaflix.bridge.ObaLog
import com.unity3d.mediation.*
import com.unity3d.mediation.interstitial.*
import com.unity3d.mediation.rewarded.*
import java.lang.ref.WeakReference
import kotlin.random.Random

/** Single SDK owner; no activity retained beyond the bounded operation.
 * One signed initialization identity = one rewarded challenge for this rollout.
 */
class LevelPlayAds(context: Context) : InterstitialAdProvider {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private var identity: String? = null
    private val anonymousIdentity = java.util.UUID.randomUUID().toString().replace("-", "")
    private var initialized = false
    private var busy = false
    private var interstitial: LevelPlayInterstitialAd? = null
    private var rewarded: LevelPlayRewardedAd? = null
    private var generation = 0
    private val cap = AdSessionCap { android.os.SystemClock.elapsedRealtime() }
    private val bannerCap = AdSessionCap { android.os.SystemClock.elapsedRealtime() }
    fun bannerShown() { bannerCap.recordShow() }
    var settings = RemoteAdSettings()
        private set
    fun configure(raw: String) { settings = RemoteAdSettings.parse(raw, BuildConfig.PLAY_STORE_BUILD) }
    fun banner(activity: Activity, ready: (Boolean) -> Unit) {
        if (!BuildConfig.ADS_APPROVED || BuildConfig.DEBUG || !settings.banner || settings.sessionCap == 0 ||
            BuildConfig.LEVELPLAY_APP_KEY.isBlank() || BuildConfig.LEVELPLAY_BANNER_ID.isBlank() || busy ||
            !bannerCap.available(settings.sessionCap, settings.intervalMs)) {
            ready(false); return
        }
        val ref = WeakReference(activity)
        AdConsent.request(activity, false) { allowed ->
            val host = ref.get()
            if (!allowed || host == null || host.isDestroyed || host.isFinishing) { ready(false); return@request }
            if (initialized) { ready(true); return@request }
            if (identity != null) { ready(false); return@request }
            identity = anonymousIdentity
            LevelPlay.init(app, LevelPlayInitRequest.Builder(BuildConfig.LEVELPLAY_APP_KEY).withUserId(anonymousIdentity).build(), object : LevelPlayInitListener {
                override fun onInitSuccess(configuration: LevelPlayConfiguration) { initialized = true; ready(true) }
                override fun onInitFailed(error: LevelPlayInitError) { ready(false) }
            })
        }
    }
    override val pronto get() = initialized && interstitial?.isAdReady() == true
    // Initialization requires Activity consent + server-authorized demand.
    override fun initialize() = Unit
    override fun preload() { if (initialized && !busy && !BuildConfig.PLAY_STORE_BUILD) interstitial?.loadAd() }
    override fun show(host: AdHost, aoAbrir: () -> Unit, aoTerminar: (AdShowOutcome) -> Unit) {
        val activity = (host as? ActivityAdHost)?.activity()
        if (activity == null || BuildConfig.PLAY_STORE_BUILD || !pronto || busy) {
            aoTerminar(AdShowOutcome.NAO_EXIBIDO); return
        }
        request(activity, identity ?: "", false, opened = aoAbrir) { displayed, _ ->
            aoTerminar(if (displayed) AdShowOutcome.EXIBIDO else AdShowOutcome.NAO_EXIBIDO)
        }
    }

    fun request(activity: Activity, challenge: String, reward: Boolean, canShow: () -> Boolean = { true }, opened: () -> Unit = {},
                done: (Boolean, AdFailure?) -> Unit) {
        val initIdentity = if (reward) challenge else anonymousIdentity
        val format = if (reward) AdFormat.REWARDED else AdFormat.INTERSTITIAL
        val unit = if (reward) BuildConfig.LEVELPLAY_REWARDED_ID else BuildConfig.LEVELPLAY_INTERSTITIAL_ID
        val enabled = BuildConfig.ADS_APPROVED && if (reward) settings.rewarded else settings.interstitial
        if (!AdSafetyPolicy.allows(BuildConfig.PLAY_STORE_BUILD, format, enabled,
                true, true, false, reward) || BuildConfig.DEBUG || BuildConfig.LEVELPLAY_APP_KEY.isBlank() || unit.isBlank()) {
            done(false, AdFailure.SDK_UNAVAILABLE); return
        }
        if (busy || !cap.available(settings.sessionCap, settings.intervalMs)) { done(false, AdFailure.INELIGIBLE); return }
        if (identity != null && identity != initIdentity) { done(false, AdFailure.SDK_UNAVAILABLE); return }
        busy = true
        val run = ++generation
        val ref = WeakReference(activity)
        var finished = false
        var displayed = false
        var loading = false
        var attempt = 0
        val watchdog = Runnable {
            if (!finished && generation == run) {
                finished = true; busy = false
                done(false, AdFailure.TIMEOUT)
            }
        }
        fun finish(success: Boolean, error: AdFailure?) {
            if (finished || generation != run) return
            finished = true; busy = false
            main.removeCallbacks(watchdog)
            if (success) cap.recordShow()
            if (!success) AdMetrics.count(format, "failure")
            ObaLog.evento("ADS", if (success) "ads_closed" else "ads_failed", "format" to format.name, "reason" to error?.name)
            done(success, error)
        }
        fun alive(): Activity? = ref.get()?.takeIf { !finished && generation == run && !it.isDestroyed && !it.isFinishing && it.hasWindowFocus() }
        fun shown() {
            if (finished) return
            displayed = true
            AdMetrics.count(format, "show")
            main.removeCallbacks(watchdog)
            main.postDelayed(watchdog, 180_000)
            opened()
            ObaLog.evento("ADS", "ads_show", "format" to format.name)
        }
        fun load() {
            if (finished || loading || alive() == null) { if (!finished) finish(false, AdFailure.CANCELLED); return }
            loading = true
            AdMetrics.count(format, "request")
            ObaLog.evento("ADS", "ads_request", "format" to format.name)
            if (reward) rewarded?.loadAd() else interstitial?.loadAd()
        }
        fun failedLoad(error: LevelPlayAdError) {
            loading = false
            AdMetrics.count(format, "failure")
            if (finished) return
            val delay = AdSafetyPolicy.retryDelay(attempt++, Random.nextDouble())
            if (delay == null) finish(false, AdSafetyPolicy.loadFailure(error.errorCode))
            else main.postDelayed({ if (!finished) load() }, delay)
        }
        fun loaded() {
            loading = false
            val stillEnabled = if (reward) settings.rewarded else settings.interstitial
            if (!canShow() || !stillEnabled || !cap.available(settings.sessionCap, settings.intervalMs)) {
                finish(false, AdFailure.CANCELLED); return
            }
            val host = alive() ?: kotlin.run { finish(false, AdFailure.CANCELLED); return }
            AdMetrics.count(format, "load")
            ObaLog.evento("ADS", "ads_load", "format" to format.name)
            if (reward) rewarded?.showAd(host) else interstitial?.showAd(host)
        }
        fun ready() {
            initialized = true
            if (reward) {
                rewarded = LevelPlayRewardedAd(unit).also { ad ->
                    ad.setListener(object : LevelPlayRewardedAdListener {
                        override fun onAdLoaded(adInfo: LevelPlayAdInfo) = loaded()
                        override fun onAdLoadFailed(error: LevelPlayAdError) = failedLoad(error)
                        override fun onAdDisplayed(adInfo: LevelPlayAdInfo) = shown()
                        override fun onAdRewarded(value: LevelPlayReward, adInfo: LevelPlayAdInfo) {
                            // Product metric only. No grant, no client proof.
                            ObaLog.evento("ADS", "ads_completion", "format" to "REWARDED")
                            AdMetrics.count(AdFormat.REWARDED, "completion")
                        }
                        override fun onAdClosed(adInfo: LevelPlayAdInfo) = finish(displayed, null)
                        override fun onAdDisplayFailed(error: LevelPlayAdError, adInfo: LevelPlayAdInfo) = finish(false, AdFailure.SHOW)
                    })
                    ad.setImpressionDataListener { data -> AdMetrics.revenue(AdFormat.REWARDED, data.revenue) }
                }
            } else {
                interstitial = LevelPlayInterstitialAd(unit).also { ad ->
                    ad.setListener(object : LevelPlayInterstitialAdListener {
                        override fun onAdLoaded(adInfo: LevelPlayAdInfo) = loaded()
                        override fun onAdLoadFailed(error: LevelPlayAdError) = failedLoad(error)
                        override fun onAdDisplayed(adInfo: LevelPlayAdInfo) = shown()
                        override fun onAdClosed(adInfo: LevelPlayAdInfo) = finish(displayed, null)
                        override fun onAdDisplayFailed(error: LevelPlayAdError, adInfo: LevelPlayAdInfo) = finish(false, AdFailure.SHOW)
                    })
                    ad.setImpressionDataListener { data -> AdMetrics.revenue(AdFormat.INTERSTITIAL, data.revenue) }
                }
            }
            load()
        }
        main.postDelayed(watchdog, 45_000)
        AdConsent.request(activity, false) consentResult@ { allowed ->
            if (finished) return@consentResult
            if (!allowed) { finish(false, AdFailure.CONSENT_DENIED); return@consentResult }
            if (initialized) ready()
            else {
                identity = initIdentity
                LevelPlay.init(app, LevelPlayInitRequest.Builder(BuildConfig.LEVELPLAY_APP_KEY).withUserId(initIdentity).build(), object : LevelPlayInitListener {
                    override fun onInitSuccess(configuration: LevelPlayConfiguration) { if (!finished) ready() }
                    override fun onInitFailed(error: LevelPlayInitError) = finish(false, AdFailure.LOAD)
                })
            }
        }
    }
}
