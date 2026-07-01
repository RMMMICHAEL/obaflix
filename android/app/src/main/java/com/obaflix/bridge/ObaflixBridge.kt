package com.obaflix.bridge

import android.webkit.JavascriptInterface
import android.webkit.WebView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Exposta ao JavaScript como `window._obaflixBridge`.
 * O CustomPlayer.tsx usa `window.obaflixDesktop` — o shim JS (injetado em onPageFinished)
 * cria esse objeto e converte callbacks em Promises.
 *
 * Equivalente ao preload.js + ipcMain do Electron.
 */
class ObaflixBridge(
    private val webView: WebView,
    private val scope: CoroutineScope,
) {

    @JavascriptInterface
    fun extractStream(callbackId: String, embedUrl: String) {
        scope.launch {
            try {
                val result = StreamExtractor.extract(embedUrl)
                val json = JSONObject().apply {
                    put("stream", result.stream)
                    put("tipo", if (result.stream.contains(".mp4")) "mp4" else "hls")
                    put("referer", result.referer)
                }.toString()
                resolveCallback(callbackId, json)
            } catch (e: Exception) {
                val json = JSONObject().put("error", e.message ?: "Erro desconhecido").toString()
                resolveCallback(callbackId, json)
            }
        }
    }

    private fun resolveCallback(id: String, json: String) {
        val escaped = json.replace("\\", "\\\\").replace("'", "\\'")
        webView.post {
            webView.evaluateJavascript(
                "(function(){ var cb = (window._obaflixCallbacks||{})['$id']; if(cb) cb.resolve(JSON.parse('$escaped')); })();",
                null
            )
        }
    }
}
