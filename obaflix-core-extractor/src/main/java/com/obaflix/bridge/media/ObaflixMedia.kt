package com.obaflix.bridge.media

import android.annotation.SuppressLint
import android.util.Base64
import android.util.Log
import android.view.ViewGroup
import android.webkit.*
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.obaflix.removerRequestedWithHeader
import kotlinx.coroutines.*
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

data class MediaRequest(val type: String, val tmdb: Long, val season: Int, val episode: Int, val quality: String = "720p") {
    init {
        require(type == "serie" && tmdb in 1..9007199254740991L && season > 0 && episode > 0) { "Série/episódio inválido" }
        require(quality in setOf("360p", "720p", "1080p")) { "Qualidade inválida" }
    }
    fun json() = JSONObject().put("type", type).put("tmdb", tmdb).put("season", season)
        .put("episode", episode).put("quality", quality)
}

data class MediaSession(val sessionId: String, val stream: String, val quality: String) {
    fun json() = JSONObject().put("sessionId", sessionId).put("stream", stream)
        .put("streamType", "mp4").put("tipo", "mp4").put("quality", quality)
        .put("platform", "android").put("provider", "embedplay-bridge")
}

/** Per-player owner. start replaces its previous session; an obsolete stop is harmless. */
class ObaflixMedia(private val container: ViewGroup) {
    private var active: Session? = null // Main-thread confined, including WebView callbacks.
    private val ids = AtomicLong()

    private class Session(val id: String) {
        lateinit var webView: WebView
        fun hasWebView() = ::webView.isInitialized
        val ready = CompletableDeferred<JavaScriptReplyProxy>()
        val replies = ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()
        @Volatile var server: LocalMediaServer? = null
        @Volatile var closed = false
        var frame: JavaScriptReplyProxy? = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    suspend fun start(request: MediaRequest): MediaSession = withContext(Dispatchers.Main.immediate) {
        check(WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            "Atualize o Android System WebView: mensagens por frame/document-start indisponíveis"
        }
        active?.let(::destroy)
        val token = ByteArray(24).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val session = Session(token)
        active = session
        val bridgeStarted = android.os.SystemClock.elapsedRealtime()
        Log.i("ObaflixMedia", "START ${token.take(8)}")
        try {
            withTimeout(100_000) {
                session.webView = WebView(container.context).apply {
                    layoutParams = ViewGroup.LayoutParams(1, 1)
                    alpha = 0.01f
                    isFocusable = false
                    isClickable = false
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.mediaPlaybackRequiresUserGesture = false
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                    removerRequestedWithHeader(settings, "media-bridge")
                    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                    webChromeClient = WebChromeClient()
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                            request.url.scheme != "https" || (request.isForMainFrame && request.url.host != "www.embedplay.one")

                        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                            if (request.isForMainFrame) session.ready.completeExceptionally(Exception(error.description.toString()))
                        }

                        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                            destroy(session)
                            return true
                        }
                    }
                }
                Log.i(
                    "ObaflixMedia",
                    "WEBVIEW_READY +${android.os.SystemClock.elapsedRealtime() - bridgeStarted}ms",
                )
                val origins = setOf("https://www.embedplay.one", "https://abysscdn.com")
                WebViewCompat.addWebMessageListener(session.webView, "__obaMediaFrame", origins) { _, message, origin, mainFrame, proxy ->
                    if (active !== session || session.closed) return@addWebMessageListener
                    val raw = message.data ?: return@addWebMessageListener
                    if (raw.length > 400_000) return@addWebMessageListener
                    val data = runCatching { JSONObject(raw) }.getOrNull() ?: return@addWebMessageListener
                    val abyss = origin.scheme == "https" && origin.host == "abysscdn.com"
                    when (data.optString("kind")) {
                        "ready" -> if (abyss && session.frame == null) {
                            Log.i(
                                "ObaflixMedia",
                                "ABYSS_READY +${android.os.SystemClock.elapsedRealtime() - bridgeStarted}ms",
                            )
                            session.frame = proxy
                            session.ready.complete(proxy)
                        }
                        "range" -> if (abyss && session.frame === proxy) {
                            session.replies.remove(data.optString("id"))?.complete(data)
                        }
                        "error" -> if (abyss || mainFrame) session.ready.completeExceptionally(Exception(data.optString("error")))
                        "stage" -> Log.i(
                            "ObaflixMedia",
                            "ABYS_RESOLVED +${android.os.SystemClock.elapsedRealtime() - bridgeStarted}ms",
                        )
                    }
                }
                val script = container.context.assets.open("obaflix-media-frame.js").bufferedReader().use { it.readText() }
                    .replace("__OBA_REQUEST__", request.json().toString())
                WebViewCompat.addDocumentStartJavaScript(session.webView, script, origins)
                container.addView(session.webView, 0)
                Log.i(
                    "ObaflixMedia",
                    "LOAD_URL +${android.os.SystemClock.elapsedRealtime() - bridgeStarted}ms",
                )
                session.webView.loadUrl("https://www.embedplay.one/serie/${request.tmdb}/${request.season}/${request.episode}")

                session.ready.await()
                Log.i(
                    "ObaflixMedia",
                    "READY_AWAIT_DONE +${android.os.SystemClock.elapsedRealtime() - bridgeStarted}ms",
                )

                val probeStarted = android.os.SystemClock.elapsedRealtime()
                val probe = fetch(session, 0, LocalMediaServer.CHUNK_SIZE - 1L)
                val total = probe.first
                val probeBytes = probe.second
                Log.i(
                    "ObaflixMedia",
                    "PROBE_DONE probeMs=${android.os.SystemClock.elapsedRealtime() - probeStarted} totalMs=${android.os.SystemClock.elapsedRealtime() - bridgeStarted}",
                )
                withContext(Dispatchers.IO) {
                    val server = LocalMediaServer(token, total) { start, end ->
                        if (start == 0L && end == probeBytes.size.toLong() - 1L) {
                            Log.i("ObaflixMedia", "PROBE_CACHE_HIT bytes=${probeBytes.size}")
                            probeBytes
                        } else {
                            val result = fetch(session, start, end)
                            check(result.first == total) { "Media size changed" }
                            result.second
                        }
                    }
                    synchronized(session) {
                        if (session.closed) server.close() else session.server = server
                    }
                }
                check(active === session && !session.closed) { "Sessão substituída" }
                Log.i(
                    "ObaflixMedia",
                    "SESSION_READY ${token.take(8)} +${android.os.SystemClock.elapsedRealtime() - bridgeStarted}ms",
                )
                MediaSession(token, session.server!!.stream, request.quality)
            }
        } catch (error: Throwable) {
            destroy(session)
            throw error
        }
    }

    private suspend fun fetch(session: Session, start: Long, end: Long): Pair<Long, ByteArray> {
        val id = ids.incrementAndGet().toString()
        val reply = CompletableDeferred<JSONObject>()
        try {
            withContext(Dispatchers.Main.immediate) {
                check(active === session && !session.closed) { "Sessão encerrada" }
                session.replies[id] = reply
                session.frame!!.postMessage(JSONObject().put("kind", "range").put("id", id)
                    .put("start", start).put("end", end).toString())
            }
            val response = withTimeout(30_000) { reply.await() }
            check(!response.has("error")) { response.optString("error") }
            val range = Regex("bytes (\\d+)-(\\d+)/(\\d+)").matchEntire(response.getString("contentRange"))
                ?: error("Content-Range inválido")
            check(range.groupValues[1].toLong() == start && range.groupValues[2].toLong() == end)
            val total = range.groupValues[3].toLong()
            check(total > end && total <= 9007199254740991L)
            val bytes = Base64.decode(response.getString("base64"), Base64.DEFAULT)
            check(bytes.size.toLong() == end - start + 1)
            return total to bytes
        } finally {
            session.replies.remove(id)
            if (!reply.isCompleted) withContext(NonCancellable + Dispatchers.Main.immediate) {
                if (!session.closed) session.frame?.postMessage(JSONObject().put("kind", "cancel").put("id", id).toString())
            }
        }
    }

    suspend fun stop(sessionId: String): JSONObject = withContext(Dispatchers.Main.immediate) {
        active?.takeIf { it.id == sessionId }?.let(::destroy)
        JSONObject().put("ok", true)
    }

    /** Navigation/dispose also cancels starts that have not returned a sessionId yet. Main thread. */
    fun close() {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
        active?.let(::destroy)
    }

    private fun destroy(session: Session) {
        synchronized(session) {
            if (session.closed) return
            session.closed = true
            session.server?.close()
        }
        if (active === session) active = null
        session.ready.cancel()
        session.replies.values.forEach { it.cancel() }
        session.replies.clear()
        if (session.hasWebView()) {
            (session.webView.parent as? ViewGroup)?.removeView(session.webView)
            session.webView.stopLoading()
            session.webView.destroy()
        }
        Log.i("ObaflixMedia", "SESSION_CLOSED ${session.id.take(8)}")
    }
}
