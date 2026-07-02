package com.obaflix.player

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.obaflix.BuildConfig
import com.obaflix.ObaflixApp
import com.obaflix.bridge.StreamExtractor
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.URL

/**
 * Substitui os handlers Electron em um único WebViewClient:
 *   - onBeforeRequest: intercept extract rola3/4 + CDN bypass (native=1)
 *   - onBeforeSendHeaders: injeção de Referer/UA nos requests CDN
 *   - onHeadersReceived: remoção do CSP
 *
 * shouldInterceptRequest é chamado em background thread — operações bloqueantes são seguras.
 */
class PlayerWebViewClient(
    private val onPageReady: ((WebView) -> Unit)? = null,
) : WebViewClient() {

    override fun onPageFinished(view: WebView, url: String) {
        super.onPageFinished(view, url)
        onPageReady?.invoke(view)
    }

    private val UA =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/122.0.0.0 Mobile Safari/537.36 ObaflixApp/1.0"

    private val EMBED_HOSTNAMES = setOf(
        "embedplayer2.xyz", "embedplayer1.xyz",
        "xn--kcksk7a2bl5le7b6doc1h3f.com", "llanfairpwllgwyngy.com",
        "playhide.shop", "streamwish.com", "hlswish.com",
        "playerwish.com", "jvrkt.online", "beamy.online",
        "boltcdn.xyz", "bigshare.link", "luluvdo.com",
    )

    private fun isRola34Url(url: String): Boolean {
        return Regex("/(rola3|rola4)/").containsMatchIn(url)
            || url.contains("embedplayer")
            || url.contains("xn--kcksk7a2bl5le7b6doc1h3f")
    }

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? {
        val urlStr = request.url.toString()
        val path = request.url.path ?: ""
        val host = request.url.host ?: ""

        // 1. Extração rola3/4 → StreamExtractor (usa OkHttp com IP do usuário)
        if (path == "/api/player/extract") {
            val embedUrl = request.url.getQueryParameter("url") ?: return null
            if (isRola34Url(embedUrl)) {
                return try {
                    val result = runBlocking { StreamExtractor.extract(embedUrl) }
                    val json = JSONObject().apply {
                        put("stream", result.stream)
                        put("tipo", if (result.stream.contains(".mp4")) "mp4" else "hls")
                        put("referer", result.referer)
                    }.toString()
                    WebResourceResponse(
                        "application/json", "UTF-8",
                        ByteArrayInputStream(json.toByteArray()),
                    )
                } catch (e: Exception) {
                    val json = JSONObject().put("error", e.message ?: "Erro").toString()
                    WebResourceResponse(
                        "application/json", "UTF-8", 422, "Unprocessable Entity",
                        mapOf("Access-Control-Allow-Origin" to "*"),
                        ByteArrayInputStream(json.toByteArray()),
                    )
                }
            }
        }

        // 2. Proxy CDN bypass: /api/player/proxy?url=<cdn>&native=1 (sem sig=)
        if (path == "/api/player/proxy") {
            val cdnUrl = request.url.getQueryParameter("url") ?: return null
            val hasSig = request.url.getQueryParameter("sig") != null
            val isNative = request.url.getQueryParameter("native") == "1"
            if (!hasSig && isNative) {
                return fetchCdnDirect(cdnUrl, request)
            }
        }

        // 3. Remove CSP das respostas do Vercel
        if (host.contains("obaflix") || host.contains("vercel")) {
            return fetchWithoutCsp(urlStr, request)
        }

        return null
    }

    private fun fetchCdnDirect(cdnUrl: String, original: WebResourceRequest): WebResourceResponse? {
        return try {
            val state = ObaflixApp.playerState
            val reqBuilder = Request.Builder().url(cdnUrl).get()
                .addHeader("User-Agent", UA)

            // Injeta Referer e Origin do embed se o CDN hostname corresponder
            val cdnHost = try { URL(cdnUrl).host } catch (_: Exception) { "" }
            val isCdnHost = state.cdnHostname != null &&
                (cdnHost == state.cdnHostname || cdnHost.endsWith(".${state.cdnHostname}"))
            if (isCdnHost && state.embedReferer != null) {
                reqBuilder.addHeader("Referer", state.embedReferer!!)
                try {
                    val embedOrigin = URL(state.embedReferer!!).let { "${it.protocol}://${it.host}" }
                    reqBuilder.addHeader("Origin", embedOrigin)
                } catch (_: Exception) { }
            }

            original.requestHeaders["Range"]?.let { reqBuilder.addHeader("Range", it) }

            val response = ObaflixApp.httpClient.newCall(reqBuilder.build()).execute()
            val contentType = response.header("Content-Type", "application/octet-stream")!!
            val body = response.body?.bytes() ?: return null
            val headers = mutableMapOf(
                "Cache-Control" to "public, max-age=3600",
                "Access-Control-Allow-Origin" to "*",
            )
            response.header("Content-Range")?.let { headers["Content-Range"] = it }

            WebResourceResponse(
                contentType, "UTF-8", response.code, response.message,
                headers, ByteArrayInputStream(body),
            )
        } catch (_: Exception) { null }
    }

    private fun fetchWithoutCsp(urlStr: String, original: WebResourceRequest): WebResourceResponse? {
        return try {
            val reqBuilder = Request.Builder().url(urlStr)
            original.requestHeaders.forEach { (k, v) -> reqBuilder.addHeader(k, v) }
            reqBuilder.removeHeader("User-Agent").addHeader("User-Agent", UA)

            val response = ObaflixApp.httpClient.newCall(reqBuilder.build()).execute()
            val contentType = response.header("Content-Type", "text/html")!!
            val body = response.body?.bytes() ?: return null

            val headers = response.headers.toMultimap()
                .filterKeys { key ->
                    !key.equals("content-security-policy", ignoreCase = true) &&
                    !key.equals("content-security-policy-report-only", ignoreCase = true)
                }
                .mapValues { it.value.joinToString(", ") }
                .toMutableMap()

            WebResourceResponse(
                contentType, "UTF-8", response.code, response.message,
                headers, ByteArrayInputStream(body),
            )
        } catch (_: Exception) { null }
    }
}
