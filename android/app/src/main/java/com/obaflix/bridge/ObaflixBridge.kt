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
 * Exposta ao JavaScript como window._obaflixBridge.
 *
 * O CustomPlayer.tsx usa window.obaflixDesktop.
 * O shim JS injetado em onPageFinished cria esse objeto
 * e converte callbacks em Promises.
 *
 * Equivalente ao preload.js + ipcMain do Electron.
 */
class ObaflixBridge(
    private val webView: WebView,
    private val scope: CoroutineScope,
    private val capability: String,
) {

    private fun authorized(value: String): Boolean = value == capability

    /**
     * Exibe um Toast nativo com erros enviados pelo JavaScript.
     */
    @JavascriptInterface
    fun logError(capability: String, msg: String) {
        if (!authorized(capability)) return
        Log.e(
            TAG,
            "[bridge/debug] JS Error: $msg"
        )

        webView.post {
            Toast.makeText(
                webView.context,
                msg.take(300),
                Toast.LENGTH_LONG
            ).show()
        }
    }

    /**
     * Mantém a tela do Android ligada enquanto o player
     * estiver aberto.
     *
     * Não exige permissão no AndroidManifest.
     */
    @JavascriptInterface
    fun setKeepScreenOn(capability: String, enabled: Boolean) {
        if (!authorized(capability)) return
        Log.d(
            TAG,
            "[bridge] setKeepScreenOn=$enabled"
        )

        webView.post {
            webView.keepScreenOn = enabled
        }
    }

    @JavascriptInterface
    fun extractStream(
        capability: String,
        callbackId: String,
        embedUrl: String
    ) {
        if (!authorized(capability) || callbackId.length > 128 || embedUrl.length > 4096) return
        Log.d(
            TAG,
            "[bridge] extractStream chamado: " +
                "id=$callbackId"
        )

        scope.launch {
            try {
                val result = StreamExtractor.extract(embedUrl)

                val json = JSONObject().apply {
                    put("stream", result.stream)
                    put("tipo", if (result.stream.contains(".mp4")) "mp4" else "hls")
                    if (result.referer != null) {
                        put("referer", result.referer)
                    } else {
                        put("referer", JSONObject.NULL)
                    }
                    put("subtitles", org.json.JSONArray().apply {
                        result.subtitles.forEachIndexed { index, track ->
                            put(JSONObject().apply {
                                put("file", track.file)
                                put("label", track.label)
                                put("kind", "captions")
                                put("default", index == 0)
                            })
                        }
                    })
                }.toString()

                Log.d(
                    TAG,
                    "[bridge] extractStream resolvido: " +
                        "id=$callbackId"
                )

                resolveCallback(callbackId, json)
            } catch (e: Exception) {
                Log.e(
                    TAG,
                    "[bridge] extractStream falhou: " +
                        "id=$callbackId erro=${e.message}"
                )

                val json = JSONObject()
                    .put(
                        "error",
                        e.message ?: "Erro desconhecido"
                    )
                    .toString()

                resolveCallback(callbackId, json)
            }
        }
    }

    private fun resolveCallback(
        id: String,
        json: String
    ) {
        // Base64 evita problemas com aspas, barras
        // e caracteres especiais no JavaScript.
        val b64 = Base64.encodeToString(
            json.toByteArray(Charsets.UTF_8),
            Base64.NO_WRAP
        )

        webView.post {
            webView.evaluateJavascript(
                """
                (function() {
                    var callbacks =
                        window._obaflixCallbacks || {};

                    var cb = callbacks['$id'];

                    if (cb) {
                        try {
                            cb.resolve(
                                JSON.parse(atob('$b64'))
                            );
                        } catch (e) {
                            cb.reject(e);
                        }
                    }
                })()
                """.trimIndent(),
                null
            )
        }
    }
}
