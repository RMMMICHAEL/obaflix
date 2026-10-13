package com.obaflix.ads

import android.app.Activity
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import com.obaflix.BuildConfig
import com.unity3d.mediation.*
import com.unity3d.mediation.banner.*
import java.lang.ref.WeakReference
import kotlin.random.Random

/** Dedicated bottom band: the WebView is resized, never covered by the ad. */
class AdBannerHost(activity: Activity, web: WebView) {
    private val activityRef = WeakReference(activity)
    private val webRef = WeakReference(web)
    private val handler = Handler(Looper.getMainLooper())
    private var band: FrameLayout? = null
    private var ad: LevelPlayBannerAdView? = null
    private var generation = 0
    private var savedMargin = 0
    private var pending = false
    fun destroy() {
        generation++
        pending = false
        handler.removeCallbacksAndMessages(null)
        ad?.destroy(); ad = null
        band?.let { (it.parent as? FrameLayout)?.removeView(it) }
        band = null
        val web = webRef.get() ?: return
        (web.layoutParams as? FrameLayout.LayoutParams)?.let { it.bottomMargin = savedMargin; web.layoutParams = it }
    }
    fun pause() { ad?.pauseAutoRefresh() }
    fun show(runtime: LevelPlayAds) {
        if (pending || band != null) return
        val activity = activityRef.get() ?: return
        val web = webRef.get() ?: return
        if (web.visibility != View.VISIBLE || activity.isDestroyed || activity.isFinishing) return
        pending = true
        val run = ++generation
        handler.postDelayed({ if (run == generation) destroy() }, 30_000)
        runtime.banner(activity) { allowed ->
            if (run != generation) return@banner
            val host = activityRef.get()
            val page = webRef.get()
            if (!allowed || host == null || host.isDestroyed || host.isFinishing || page == null || page.visibility != View.VISIBLE) { destroy(); return@banner }
            val parent = page.parent as? FrameLayout ?: kotlin.run { destroy(); return@banner }
            fun dp(value: Int) = (value * host.resources.displayMetrics.density).toInt()
            val strip = FrameLayout(host).apply { setBackgroundColor(Color.rgb(17, 17, 22)) }
            val label = TextView(host).apply { text = "Publicidade"; textSize = 10f; setTextColor(Color.LTGRAY); gravity = Gravity.CENTER }
            strip.addView(label, FrameLayout.LayoutParams(-1, dp(20), Gravity.TOP))
            val view = LevelPlayBannerAdView(host, BuildConfig.LEVELPLAY_BANNER_ID,
                LevelPlayBannerAdView.Config.Builder().setAdSize(LevelPlayAdSize.BANNER).build())
            strip.addView(view, FrameLayout.LayoutParams(dp(320), dp(50), Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL))
            val params = page.layoutParams as FrameLayout.LayoutParams
            savedMargin = params.bottomMargin
            params.bottomMargin = savedMargin + dp(74)
            page.layoutParams = params
            parent.addView(strip, FrameLayout.LayoutParams(-1, dp(74), Gravity.BOTTOM))
            band = strip; ad = view
            var attempt = 0
            view.setBannerListener(object : LevelPlayBannerAdViewListener {
                override fun onAdLoaded(adInfo: LevelPlayAdInfo) {
                    if (run != generation) return
                    handler.removeCallbacksAndMessages(null)
                    pending = false
                    view.pauseAutoRefresh()
                    AdMetrics.count(AdFormat.BANNER, "load")
                }
                override fun onAdLoadFailed(error: LevelPlayAdError) {
                    if (run != generation) return
                    AdMetrics.count(AdFormat.BANNER, "failure")
                    val delay = AdSafetyPolicy.retryDelay(attempt++, Random.nextDouble())
                    if (delay == null) destroy()
                    else handler.postDelayed({ if (run == generation) view.loadAd() }, delay)
                }
                override fun onAdDisplayed(adInfo: LevelPlayAdInfo) {
                    if (run == generation) { runtime.bannerShown(); AdMetrics.count(AdFormat.BANNER, "show") }
                }
            })
            view.setImpressionDataListener { data -> AdMetrics.revenue(AdFormat.BANNER, data.revenue) }
            AdMetrics.count(AdFormat.BANNER, "request")
            view.loadAd()
        }
    }
}
