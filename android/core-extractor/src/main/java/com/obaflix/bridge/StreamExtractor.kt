package com.obaflix.bridge

import com.obaflix.ObaflixApp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.URL
import java.net.InetAddress

data class ExtractResult(
    val stream: String,
    val referer: String?,
    val subtitles: List<SubtitleTrack> = emptyList(),
    val tipo: String? = null,
    val isMaster: Boolean = false,
    val qualities: List<String> = emptyList(),
    val audioTracks: List<String> = emptyList(),
    val expiresAt: Long? = null,
    val userAgent: String? = null,
    val effectiveOptionKey: String? = null,
    val effectiveOptionLabel: String? = null,
    val effectiveOptionIsFile: Boolean? = null,
)

// Dispatcher genérico: delega a extração real para PlayerExtractors e atualiza o
// playerState compartilhado, usado pelo PlayerWebViewClient para injetar headers no CDN.
object StreamExtractor {

    /** Valida e publica no player um resultado resolvido sob demanda. */
    suspend fun acceptNativeResult(nativeResult: NativeExtractResult): ExtractResult {
        val parsedStream = URL(nativeResult.stream)
        if (parsedStream.protocol != "https") throw Exception("Stream inseguro")
        val addresses = withContext(Dispatchers.IO) {
            InetAddress.getAllByName(parsedStream.host)
        }
        if (addresses.isEmpty() || addresses.any {
                it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress ||
                    it.isSiteLocalAddress || it.isMulticastAddress
            }
        ) throw Exception("Destino de stream bloqueado")

        ObaflixApp.playerState.resetCdnHosts(parsedStream.host)
        ObaflixApp.playerState.embedReferer = nativeResult.referer
        ObaflixApp.playerState.mediaUserAgent = nativeResult.userAgent
        return ExtractResult(
            stream = nativeResult.stream,
            referer = nativeResult.referer,
            subtitles = nativeResult.subtitles,
            tipo = nativeResult.tipo,
            isMaster = nativeResult.isMaster,
            qualities = nativeResult.qualities,
            audioTracks = nativeResult.audioTracks,
            expiresAt = nativeResult.expiresAt,
            userAgent = nativeResult.userAgent,
            effectiveOptionKey = nativeResult.effectiveOptionKey,
            effectiveOptionLabel = nativeResult.effectiveOptionLabel,
            effectiveOptionIsFile = nativeResult.effectiveOptionIsFile,
        )
    }

    suspend fun extract(embedUrl: String): ExtractResult {
        val provedor = PlayerExtractors.detectProvider(embedUrl) ?: "desconhecido"
        ObaLog.evento(ObaLog.Fase.EXTRACAO, "inicio", "provedor" to provedor)

        val comeco = System.currentTimeMillis()
        val nativeResult = try {
            PlayerExtractors.extractResult(embedUrl)
        } catch (e: Exception) {
            // A mensagem crua do provedor raramente diz a fase; NetworkDiagnostics
            // separa DNS/TCP/TLS/HTTP, que e a diferenca entre "provedor fora do
            // ar" e "este Android nao negocia o TLS que ele exige".
            ObaLog.falha(
                ObaLog.Fase.EXTRACAO, "provedor_falhou", e,
                "provedor" to provedor,
                "diagnostico" to NetworkDiagnostics.describe(e, embedUrl),
                "ms" to (System.currentTimeMillis() - comeco),
            )
            throw e
        }
        ObaLog.evento(
            ObaLog.Fase.EXTRACAO, "provedor_respondeu",
            "provedor" to provedor,
            "ms" to (System.currentTimeMillis() - comeco),
            "stream" to ObaLog.url(nativeResult.stream),
        )

        val stream = nativeResult.stream
        val parsedStream = URL(stream)
        if (parsedStream.protocol != "https") {
            ObaLog.falha(
                ObaLog.Fase.EXTRACAO, "stream_inseguro", null,
                "protocolo" to parsedStream.protocol,
                "host" to parsedStream.host,
            )
            throw Exception("Stream inseguro")
        }
        val addresses = withContext(Dispatchers.IO) {
            InetAddress.getAllByName(parsedStream.host)
        }
        if (addresses.isEmpty() || addresses.any {
                it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress ||
                    it.isSiteLocalAddress || it.isMulticastAddress
            }
        ) {
            ObaLog.falha(
                ObaLog.Fase.EXTRACAO, "destino_bloqueado", null,
                "host" to parsedStream.host,
                "enderecos" to addresses.size,
            )
            throw Exception("Destino de stream bloqueado")
        }

        try {
            val cdnHost = URL(stream).host
            ObaflixApp.playerState.resetCdnHosts(cdnHost)
            ObaflixApp.playerState.embedReferer = nativeResult.referer
            ObaflixApp.playerState.mediaUserAgent = nativeResult.userAgent
            ObaLog.evento(
                ObaLog.Fase.EXTRACAO, "cdn_liberado",
                "host" to cdnHost,
                "referer" to ObaLog.host(nativeResult.referer),
            )
        } catch (e: Exception) {
            // Sem host liberado, todo segmento sai sem Referer e o CDN devolve 403.
            ObaLog.alerta(ObaLog.Fase.EXTRACAO, "cdn_nao_liberado", "causa" to e.message?.take(120))
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
            userAgent = nativeResult.userAgent,
            effectiveOptionKey = nativeResult.effectiveOptionKey,
            effectiveOptionLabel = nativeResult.effectiveOptionLabel,
            effectiveOptionIsFile = nativeResult.effectiveOptionIsFile,
        )
    }
}
