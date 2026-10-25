package com.nuvio.app.integration.obaflix.ads

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.nuvio.app.integration.obaflix.ObaflixAdEligibility
import com.unity3d.mediation.LevelPlayAdError
import com.unity3d.mediation.LevelPlayAdInfo
import com.unity3d.mediation.LevelPlayAdSize
import com.unity3d.mediation.banner.LevelPlayBannerAdView
import com.unity3d.mediation.banner.LevelPlayBannerAdViewListener

private fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

@Composable
actual fun ObaflixBannerSlot(modifier: Modifier) {
    if (!ObaflixAdsConfig.BANNER_ENABLED) return
    val unit = ObaflixAdsConfig.LEVELPLAY_BANNER_UNIT_ID
    val eligibility by ObaflixAdEligibility.flow.collectAsState()
    val context = LocalContext.current
    if (unit.isBlank() || eligibility != ObaflixAdEligibility.State.ELIGIBLE ||
        !ObaflixAdsConfig.levelPlayAllowed(context)
    ) return

    val activity = remember(context) { context.findActivity() } ?: return
    val ready by ObaflixLevelPlay.ready.collectAsState()
    var loaded by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { ObaflixLevelPlay.start(activity) }
    if (!ready) return

    val banner = remember(activity) {
        LevelPlayBannerAdView(
            activity,
            unit,
            LevelPlayBannerAdView.Config.Builder().setAdSize(LevelPlayAdSize.BANNER).build(),
        ).also { view ->
            view.setBannerListener(object : LevelPlayBannerAdViewListener {
                override fun onAdLoaded(adInfo: LevelPlayAdInfo) { loaded = true }
                override fun onAdLoadFailed(error: LevelPlayAdError) { loaded = false }
                override fun onAdDisplayFailed(adInfo: LevelPlayAdInfo, error: LevelPlayAdError) { loaded = false }
            })
            view.loadAd()
        }
    }
    DisposableEffect(banner) { onDispose { banner.destroy() } }

    // Zero height until an ad is loaded: no empty strip.
    Box(
        modifier = modifier.fillMaxWidth().height(if (loaded) 50.dp else 0.dp),
        contentAlignment = Alignment.Center,
    ) {
        AndroidView(factory = { banner })
    }
}
