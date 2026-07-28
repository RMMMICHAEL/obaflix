package com.obaflix.bridge

import android.util.Log
import com.obaflix.ObaflixApp
import java.net.URL

private const val TAG = "Obaflix"

data class ExtractResult(
    val stream: String,
    val referer: String?,
)

// Dispatcher genérico: delega a extração real para PlayerExtractors e atualiza o
// playerState compartilhado, usado pelo PlayerWebViewClient para injetar headers no CDN.
object StreamExtractor {

    suspend fun extract(embedUrl: String): ExtractResult {
        Log.d(TAG, "[extract] iniciando: ${embedUrl.take(80)}")
        val nativeResult = PlayerExtractors.extractResult(embedUrl)
        val stream = nativeResult.stream
        Log.d(TAG, "[extract] stream: ${stream.take(120)}")

        try {
            val cdnHost = URL(stream).host
            ObaflixApp.playerState.cdnHostname = cdnHost
            ObaflixApp.playerState.embedReferer = nativeResult.referer
            Log.d(
                TAG,
                "[extract] playerState atualizado: cdnHostname=$cdnHost " +
                    "referer=${nativeResult.referer ?: "nenhum"}",
            )
        } catch (e: Exception) {
            Log.w(TAG, "[extract] falha ao parsear host do stream para playerState: ${e.message}")
        }

        return ExtractResult(stream = stream, referer = nativeResult.referer)
    }
}
