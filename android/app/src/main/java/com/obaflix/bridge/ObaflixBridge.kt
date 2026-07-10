package com.obaflix.bridge

import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

private const val TAG = "Obaflix"

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

    /** Chamado pelo script de diagnóstico injetado — exibe Toast nativo com o erro JS. */
    @JavascriptInterface
    fun logError(msg: String) {
        Log.e(TAG, "[bridge/debug] JS Error: $msg")
        // Toast precisa rodar na main thread; webView.post() garante isso.
        webView.post {
            Toast.makeText(webView.context, msg.take(300), Toast.LENGTH_LONG).show()
        }
    }

    @JavascriptInterface
    fun extractStream(callbackId: String, embedUrl: String) {
        Log.d(TAG, "[bridge] extractStream chamado: id=$callbackId url=${embedUrl.take(80)}")
        scope.launch {
            try {
                val result = StreamExtractor.extract(embedUrl)
                val json = JSONObject().apply {
                    put("stream", result.stream)
                    put("tipo", if (result.stream.contains(".mp4")) "mp4" else "hls")
                    put("referer", result.referer)
                }.toString()
                Log.d(TAG, "[bridge] extractStream resolvido: id=$callbackId")
                resolveCallback(callbackId, json)
            } catch (e: Exception) {
                Log.e(TAG, "[bridge] extractStream falhou: id=$callbackId erro=${e.message}")
                val json = JSONObject().put("error", e.message ?: "Erro desconhecido").toString()
                resolveCallback(callbackId, json)
            }
        }
    }

    private fun resolveCallback(id: String, json: String) {
        // Base64 evita qualquer problema de escape em JS (aspas, barras,  , etc.)
        val b64 = Base64.encodeToString(json.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        webView.post {
            webView.evaluateJavascript(
                "(function(){var cb=(window._obaflixCallbacks||{})['$id'];if(cb){try{cb.resolve(JSON.parse(atob('$b64')));}catch(e){cb.reject(e);}}})()",
                null
            )
        }
    }
}
