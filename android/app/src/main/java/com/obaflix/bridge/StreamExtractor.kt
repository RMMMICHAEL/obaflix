package com.obaflix.bridge

import android.util.Log
import com.obaflix.ObaflixApp
import java.net.URL

private const val TAG = "Obaflix"

data class ExtractResult(
    val stream: String,
    val referer: String,
)

// Dispatcher genérico: delega a extração real para PlayerExtractors (rola3/rola4,
// PlayHide, Lulu, Rola2, Wish, Bolt, Big) e atualiza o playerState compartilhado,
// usado por PlayerWebViewClient para injetar Referer/Origin nos requests ao CDN.
// Ver docs/player-native-extraction.md.
object StreamExtractor {

    suspend fun extract(embedUrl: String): ExtractResult {
        Log.d(TAG, "[extract] iniciando: ${embedUrl.take(80)}")
        val stream = PlayerExtractors.extract(embedUrl)
        Log.d(TAG, "[extract] stream: ${stream.take(120)}")

        // Atualiza playerState para que PlayerWebViewClient injete Referer nos requests CDN
        try {
            val cdnHost = URL(stream).host
            ObaflixApp.playerState.cdnHostname = cdnHost
            ObaflixApp.playerState.embedReferer = embedUrl
            Log.d(TAG, "[extract] playerState atualizado: cdnHostname=$cdnHost referer=$embedUrl")
        } catch (e: Exception) {
            Log.w(TAG, "[extract] falha ao parsear host do stream para playerState: ${e.message}")
        }

        return ExtractResult(stream = stream, referer = embedUrl)
    }
}
