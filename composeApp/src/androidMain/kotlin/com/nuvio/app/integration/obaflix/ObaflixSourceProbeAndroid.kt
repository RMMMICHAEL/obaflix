package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/** Platform side of [ObaflixSourceProbe]: HEAD, then a 2-byte ranged GET for servers that refuse HEAD. Never reads the body. */
internal object ObaflixSourceProbeAndroid {
    private val client = OkHttpClient.Builder()
        .followRedirects(true)
        .followSslRedirects(true)
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .callTimeout(12, TimeUnit.SECONDS)
        .build()

    private val MEDIA_TYPES = listOf("video/", "audio/", "application/vnd.apple.mpegurl", "application/x-mpegurl", "application/octet-stream", "binary/octet-stream", "application/mp4")

    internal fun acceptable(startedAsHttps: Boolean, finalUrlIsHttps: Boolean, status: Int, contentType: String?): Boolean {
        if (startedAsHttps && !finalUrlIsHttps) return false // a redirect must never downgrade the connection
        if (status != 200 && status != 206) return false
        val type = contentType?.lowercase()?.substringBefore(';')?.trim() ?: return false
        return MEDIA_TYPES.any { type.startsWith(it) }
    }

    private fun attempt(url: String, headers: Map<String, String>, head: Boolean): Boolean {
        val builder = Request.Builder().url(url)
        headers.forEach { (k, v) -> builder.header(k, v) }
        if (head) builder.head() else builder.get().header("Range", "bytes=0-1")
        client.newCall(builder.build()).execute().use { r ->
            return acceptable(url.startsWith("https://"), r.request.url.isHttps, r.code, r.header("Content-Type"))
        }
    }

    suspend fun check(url: String, headers: Map<String, String>): Boolean = withContext(Dispatchers.IO) {
        try {
            attempt(url, headers, head = true) || attempt(url, headers, head = false)
        } catch (_: Exception) {
            try { attempt(url, headers, head = false) } catch (_: Exception) { false }
        }
    }

    fun install() {
        ObaflixSourceProbe.check = { url, headers -> check(url, headers) }
    }
}
