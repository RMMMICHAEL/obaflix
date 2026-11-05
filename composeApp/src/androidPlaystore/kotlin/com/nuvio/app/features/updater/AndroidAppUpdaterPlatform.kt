package com.nuvio.app.features.updater

import android.content.Context

object AndroidAppUpdaterPlatform {
    fun initialize(context: Context) {
        // Play owns updates in this variant; never fall back to an external APK source.
        AppUpdaterRepository.platformUpdateSource = { Result.failure(NoChannelReleaseException()) }
    }
}