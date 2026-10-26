package com.nuvio.app.features.settings

import android.os.Build
import android.os.Handler
import android.os.Looper
import co.touchlab.kermit.Logger
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Android < 13 keeps the app language only in Locale.getDefault(), which the system resets to its
 * own language outside our control: in-place configuration changes (the player rotating) and the
 * WebView provider loading (Unity ads, source extractor). Compose resources read that default, so
 * text flips to English. This guard undoes any reset, logs where it was seen, and bumps [epoch] so
 * already rendered text re-resolves (see MainActivity). Android 13+ uses LocaleManager instead.
 */
internal object ObaflixLocaleGuard {
    private val log = Logger.withTag("ObaflixLocale")
    private val handler = Handler(Looper.getMainLooper())
    private const val CHECK_INTERVAL_MS = 500L

    private val _epoch = MutableStateFlow(0)
    val epoch: StateFlow<Int> = _epoch.asStateFlow()

    private val periodicCheck = object : Runnable {
        override fun run() {
            reassert("verificacao")
            handler.postDelayed(this, CHECK_INTERVAL_MS)
        }
    }

    /** Foreground only (MainActivity onStart/onStop): no wake-ups while the app is in background. */
    fun start(sdkInt: Int = Build.VERSION.SDK_INT) {
        if (sdkInt >= 33) return
        handler.removeCallbacks(periodicCheck)
        handler.post(periodicCheck)
    }

    fun stop() {
        handler.removeCallbacks(periodicCheck)
    }

    /** Restores the app language if something reset it; returns true when it did. */
    fun reassert(source: String, sdkInt: Int = Build.VERSION.SDK_INT): Boolean {
        val restored = ThemeSettingsStorage.restoreAppLocaleAsDefault(sdkInt)
        if (restored) {
            log.w { "locale_redefinido origem=$source" }
            _epoch.value += 1
        }
        return restored
    }
}
