package com.obaflix

import android.app.Application
import com.obaflix.bridge.PlayerState
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class ObaflixApp : Application() {

    companion object {
        lateinit var httpClient: OkHttpClient
            private set

        @Volatile
        var webViewUserAgent: String? = null

        /**
         * WebView principal, para quem precisa anexar algo a hierarquia de views
         * de fora da Activity — hoje so o overlay do desafio do SuperFlix.
         * Referencia fraca porque a Activity pode ser recriada (rotacao, morte do
         * renderer) e uma referencia forte a vazaria.
         */
        @Volatile
        var hostWebView: java.lang.ref.WeakReference<android.webkit.WebView>? = null

        val playerState = PlayerState()
    }

    override fun onCreate() {
        super.onCreate()
        httpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()
    }
}
