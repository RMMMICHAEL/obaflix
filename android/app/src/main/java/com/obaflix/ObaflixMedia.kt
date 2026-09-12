package com.obaflix

import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.obaflix.bridge.ObaLog
import com.obaflix.bridge.PlayerExtractors
import com.obaflix.bridge.StreamExtractor
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject

/** Ponte de reprodução local, deliberadamente exclusiva de episódios Playerflix. */
class ObaflixMedia(
    private val webView: WebView,
    private val scope: CoroutineScope,
    private val capability: String,
    private val server: LocalMediaServer,
) {
    private var active: Job? = null
    private fun valid(value: String) = value.length in 1..128 && value.all { it.isLetterOrDigit() || it == '_' || it == '-' }

    @JavascriptInterface
    fun start(cap: String, callbackId: String, payloadJson: String) {
        if (cap != capability || !valid(callbackId) || payloadJson.length > 8192) return
        val payload = runCatching { JSONObject(payloadJson) }.getOrNull() ?: return answer(callbackId, JSONObject().put("error", "Payload inválido"))
        val embedUrl = payload.optString("embedUrl")
        // Esta limitação de tipo é uma fronteira de produto: filme/anime/kids
        // jamais entram no loopback, mesmo que algum provedor seja identificado.
        if (payload.optString("contentType") != "serie" || PlayerExtractors.detectProvider(embedUrl) != "playerflix") {
            return answer(callbackId, JSONObject().put("error", "Bridge local disponível apenas para séries Playerflix"))
        }
        active?.cancel()
        active = scope.launch {
            try {
                val result = StreamExtractor.extract(embedUrl)
                val (sessionId, localUrl) = server.start(result.stream, result.referer, result.userAgent)
                ObaLog.evento(ObaLog.Fase.BRIDGE, "OK_PLAYBACK", "host" to "127.0.0.1", "tipo" to (result.tipo ?: "hls"))
                answer(callbackId, JSONObject().apply {
                    put("sessionId", sessionId); put("stream", localUrl); put("streamType", result.tipo ?: "hls")
                    put("referer", JSONObject.NULL); put("subtitles", org.json.JSONArray())
                    put("expiresAt", result.expiresAt ?: JSONObject.NULL)
                })
            } catch (e: CancellationException) { throw e
            } catch (e: Exception) {
                ObaLog.falha(ObaLog.Fase.BRIDGE, "local_bridge_falhou", e)
                answer(callbackId, JSONObject().put("error", e.message ?: "Falha no bridge local"))
            }
        }
    }

    @JavascriptInterface fun stop(cap: String, sessionId: String) { if (cap == capability && valid(sessionId)) server.stop(sessionId) }

    private fun answer(id: String, value: JSONObject) {
        val encoded = Base64.encodeToString(value.toString().toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
        webView.post { webView.evaluateJavascript("(function(){var c=window._obaflixCallbacks&&window._obaflixCallbacks['$id'];if(c)c.resolve(JSON.parse(atob('$encoded')));})()", null) }
    }
}
