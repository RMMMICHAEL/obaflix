package com.obaflix.bridge

import android.util.Log
import com.obaflix.ObaflixApp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.URL
import java.net.InetAddress

private const val TAG = "Obaflix"

data class ExtractResult(
    val stream: String,
    val referer: String?,
    val subtitles: List<SubtitleTrack> = emptyList(),
    val tipo: String? = null,
    val isMaster: Boolean = false,
    val qualities: List<String> = emptyList(),
    val audioTracks: List<String> = emptyList(),
    val expiresAt: Long? = null,
)

// Dispatcher genérico: delega a extração real para PlayerExtractors e atualiza o
// playerState compartilhado, usado pelo PlayerWebViewClient para injetar headers no CDN.
object StreamExtractor {

    suspend fun extract(embedUrl: String): ExtractResult {
        Log.d(TAG, "[extract] iniciando")
        val nativeResult = PlayerExtractors.extractResult(embedUrl)
        val stream = nativeResult.stream
        val parsedStream = URL(stream)
        if (parsedStream.protocol != "https") throw Exception("Stream inseguro")
        val addresses = withContext(Dispatchers.IO) {
            InetAddress.getAllByName(parsedStream.host)
        }
        if (addresses.isEmpty() || addresses.any {
                it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress ||
                    it.isSiteLocalAddress || it.isMulticastAddress
            }
        ) throw Exception("Destino de stream bloqueado")
        Log.d(TAG, "[extract] stream resolvido")

        try {
            val cdnHost = URL(stream).host
            ObaflixApp.playerState.resetCdnHosts(cdnHost)
            ObaflixApp.playerState.embedReferer = nativeResult.referer
            Log.d(
                TAG,
                "[extract] playerState atualizado: cdnHostname=$cdnHost " +
                    "referer=${nativeResult.referer ?: "nenhum"}",
            )
        } catch (e: Exception) {
            Log.w(TAG, "[extract] falha ao parsear host do stream para playerState: ${e.message}")
        }

        return ExtractResult(
            stream = stream,
            referer = nativeResult.referer,
            subtitles = nativeResult.subtitles,
            tipo = nativeResult.tipo,
            isMaster = nativeResult.isMaster,
            qualities = nativeResult.qualities,
            audioTracks = nativeResult.audioTracks,
            expiresAt = nativeResult.expiresAt,
        )
    }
}
