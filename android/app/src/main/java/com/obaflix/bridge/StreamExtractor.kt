package com.obaflix.bridge

import android.util.Log
import com.obaflix.BuildConfig
import com.obaflix.ObaflixApp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.Request
import org.json.JSONObject
import java.net.URL

private const val TAG = "Obaflix"

data class ExtractResult(
    val stream: String,
    val referer: String,
)

object StreamExtractor {

    private val UA =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/122.0.0.0 Mobile Safari/537.36 ObaflixApp/1.0"

    suspend fun extract(embedUrl: String): ExtractResult = withContext(Dispatchers.IO) {
        Log.d(TAG, "[extract] iniciando: ${embedUrl.take(80)}")
        val parsed = URL(embedUrl)
        val base = "${parsed.protocol}://${parsed.host}"
        val id = parsed.path.split("/").last { it.isNotEmpty() }

        if (id.isEmpty()) throw Exception("ID não encontrado em: $embedUrl")

        val apiUrl = "$base/player/index.php?data=$id&do=getVideo"

        val body = FormBody.Builder()
            .add("hash", id)
            .add("r", BuildConfig.OBAFLIX_URL + "/")
            .build()

        val request = Request.Builder()
            .url(apiUrl)
            .post(body)
            .addHeader("User-Agent", UA)
            .addHeader("Content-Type", "application/x-www-form-urlencoded")
            .addHeader("X-Requested-With", "XMLHttpRequest")
            .addHeader("Referer", embedUrl)
            .addHeader("Origin", base)
            .build()

        val response = ObaflixApp.httpClient.newCall(request).execute()
        val text = response.body?.string() ?: throw Exception("Resposta vazia")
        Log.d(TAG, "[extract] ${response.code} ← $apiUrl (${text.take(120)})")

        if (!text.trimStart().startsWith("{")) {
            throw Exception("Resposta inválida do player")
        }

        val json = JSONObject(text)
        val stream = json.optString("securedLink").takeIf { it.isNotEmpty() }
            ?: json.optString("videoSource").takeIf { it.isNotEmpty() }
            ?: json.optString("src").takeIf { it.isNotEmpty() }
            ?: throw Exception("securedLink não encontrado")

        // Atualiza playerState para que PlayerWebViewClient injete Referer nos requests CDN
        try {
            val cdnHost = URL(stream).host
            ObaflixApp.playerState.cdnHostname = cdnHost
            ObaflixApp.playerState.embedReferer = embedUrl
            Log.d(TAG, "[extract] playerState atualizado: cdnHostname=$cdnHost referer=$embedUrl")
        } catch (e: Exception) {
            Log.w(TAG, "[extract] falha ao parsear host do stream para playerState: ${e.message}")
        }

        ExtractResult(stream = stream, referer = embedUrl)
    }
}
