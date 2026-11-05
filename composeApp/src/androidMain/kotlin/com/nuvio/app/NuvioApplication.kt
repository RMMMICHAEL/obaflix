package com.nuvio.app

import android.app.Application
import android.os.Build
import coil3.ImageLoader
import coil3.SingletonImageLoader
import coil3.gif.AnimatedImageDecoder
import coil3.gif.GifDecoder
import coil3.network.cachecontrol.CacheControlCacheStrategy
import coil3.network.ktor3.KtorNetworkFetcherFactory
import coil3.request.CachePolicy
import coil3.request.crossfade
import coil3.svg.SvgDecoder
import com.nuvio.app.core.poster.CustomPosterFallbackInterceptor
import com.nuvio.app.integration.obaflix.ExtractedMedia
import com.nuvio.app.integration.obaflix.ObaflixNative
import com.nuvio.app.integration.obaflix.ObaflixNativeSources
import com.obaflix.bridge.StreamExtractor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Custom Application class that implements [SingletonImageLoader.Factory] to guarantee
 * the Coil ImageLoader (with [CustomPosterFallbackInterceptor]) is created before any
 * image request. Without this, Coil's auto-init ContentProvider creates the singleton
 * before MainActivity.onCreate, and interceptors registered later are ignored.
 */
// ObaflixApp.onCreate sets up the extractor HTTP clients and modern TLS before any request.
class NuvioApplication : com.obaflix.ObaflixApp(), SingletonImageLoader.Factory {

    override fun onCreate() {
        super.onCreate()
        pinPreviewBackendIfDebug()
        // Obaflix servers: same extractor as the official apps, run on the device (never via Vercel).
        ObaflixNativeSources.extractor = { embed ->
            withContext(Dispatchers.IO) {
                val r = StreamExtractor.extractResult(embed)
                ExtractedMedia(
                    url = r.stream,
                    referer = r.referer,
                    userAgent = r.userAgent,
                    isHls = r.tipo.equals("hls", true) || r.isMaster || ObaflixNativeSources.looksHls(r.stream),
                    subtitles = r.subtitles.map { it.file to it.label },
                )
            }
        }
        ObaflixNative.provider = ObaflixNativeSources
        com.nuvio.app.integration.obaflix.ObaflixWebVideoCast.install(this)
        com.nuvio.app.integration.obaflix.ObaflixCatalogDiskCache.install(this)
    }

    /**
     * DEBUG homologation only: when the debug build was assembled with `-PobaflixPreviewUrl`, every backend call goes to
     * that Vercel Preview and never to production. Release builds carry no such meta-data and ignore it anyway.
     */
    private fun pinPreviewBackendIfDebug() {
        // Release builds only read the dedicated key, which exists only in the -PobaflixHmlReal homologation build.
        val chave = if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE == 0) "obaflix.preview_release_url" else "obaflix.preview_url"
        val url = runCatching {
            packageManager.getApplicationInfo(packageName, android.content.pm.PackageManager.GET_META_DATA)
                .metaData?.getString(chave)
        }.getOrNull()?.takeIf { it.isNotBlank() } ?: return
        if (!com.nuvio.app.integration.obaflix.ObaflixConfig.usarPreview(url)) {
            // A malformed/production URL never silently falls back: say so in the log and stay on defaults.
            android.util.Log.e("ObaflixPreview", "obaflix.preview_url recusada: precisa ser https://<nome>.vercel.app")
        }
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        // Android < 13: the system just reset the default Locale to its own language in this same
        // message (e.g. the player rotating the screen); put the app language back before any UI work.
        com.nuvio.app.features.settings.ObaflixLocaleGuard.reassert("configuracao")
    }

    override fun newImageLoader(context: android.content.Context): ImageLoader {
        return ImageLoader.Builder(context)
            .crossfade(true)
            .diskCachePolicy(CachePolicy.ENABLED)
            .memoryCachePolicy(CachePolicy.ENABLED)
            .components {
                add(CustomPosterFallbackInterceptor())
                add(SvgDecoder.Factory())
                add(
                    KtorNetworkFetcherFactory(
                        cacheStrategy = { CacheControlCacheStrategy() },
                    ),
                )
                if (Build.VERSION.SDK_INT >= 28) {
                    add(AnimatedImageDecoder.Factory())
                } else {
                    add(GifDecoder.Factory())
                }
            }
            .build()
    }
}
