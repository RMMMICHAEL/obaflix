package com.nuvio.app.integration.obaflix

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/** Same hand-off as the official app (android/app cast/WebVideoCast.kt): Web Video Cast intent. */
internal object ObaflixWebVideoCast {
    private const val PACKAGE = "com.instantbits.cast.webvideo"

    fun install(context: Context) {
        val app = context.applicationContext
        ObaflixCast.handoff = { request -> handoff(app, request) }
        ObaflixCast.verificarApp = { verificar(app) }
    }

    /** Installed: OPENED (nothing opened, go on). Missing: the Play Store, else the browser page, before any ad. */
    internal fun verificar(context: Context): ObaflixCastResult =
        if (instalado(context)) ObaflixCastResult.OPENED else abrirLoja(context)

    private fun instalado(context: Context): Boolean = try {
        context.packageManager.getPackageInfo(PACKAGE, 0)
        true
    } catch (_: android.content.pm.PackageManager.NameNotFoundException) {
        false
    }

    private fun abrirLoja(context: Context): ObaflixCastResult {
        val store = listOf("market://details?id=$PACKAGE", "https://play.google.com/store/apps/details?id=$PACKAGE")
            .any { start(context, Intent(Intent.ACTION_VIEW, Uri.parse(it)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        return if (store) ObaflixCastResult.STORE_OPENED else ObaflixCastResult.UNAVAILABLE
    }

    internal fun intent(request: ObaflixCastRequest): Intent = Intent(Intent.ACTION_VIEW).apply {
        setPackage(PACKAGE)
        setDataAndType(Uri.parse(request.url), if (request.isHls) "application/x-mpegurl" else "video/mp4")
        putExtra("title", request.title)
        request.poster?.let { putExtra("poster", it) }
        putExtra("secure_uri", request.url.startsWith("https://")) // https must not be downgraded by the cast app
        if (request.headers.isNotEmpty()) {
            putExtra("android.media.intent.extra.HTTP_HEADERS", Bundle().apply {
                request.headers.forEach { (k, v) -> putString(k, v) }
            })
        }
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    private fun handoff(context: Context, request: ObaflixCastRequest): ObaflixCastResult {
        // Opening directly avoids package-visibility queries; missing app -> store.
        if (start(context, intent(request))) return ObaflixCastResult.OPENED
        return abrirLoja(context)
    }

    private fun start(context: Context, intent: Intent): Boolean = try {
        context.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }
}
