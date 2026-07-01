package com.obaflix

import android.app.Application
import com.obaflix.bridge.PlayerState
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class ObaflixApp : Application() {

    companion object {
        lateinit var httpClient: OkHttpClient
            private set

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
