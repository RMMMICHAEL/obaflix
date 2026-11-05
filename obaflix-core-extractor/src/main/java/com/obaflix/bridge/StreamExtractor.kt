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

    internal suspend fun validatePublicHttps(
        rawUrl: String,
        resolveAddresses: (String) -> Array<InetAddress> = { InetAddress.getAllByName(it) },
    ) {
        val parsed = URL(rawUrl)
        if (parsed.protocol != "https" || parsed.userInfo != null || parsed.host.isBlank()) {
            throw Exception("Stream inseguro")
        }
        val addresses = withContext(Dispatchers.IO) { resolveAddresses(parsed.host) }
        if (addresses.isEmpty() || addresses.any {
                it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress ||
                    it.isSiteLocalAddress || it.isMulticastAddress
            }) throw Exception("Destino de stream bloqueado")
    }

    /** Valida e devolve mídia. Não publica hosts ou headers na reprodução. */
    internal suspend fun resultOnly(
        nativeResult: NativeExtractResult,
        resolveAddresses: (String) -> Array<InetAddress> = { InetAddress.getAllByName(it) },
    ): ExtractResult {
        validatePublicHttps(nativeResult.stream, resolveAddresses)

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

    /** Somente o caminho de playback aplica o resultado validado. */
    fun applyToPlayback(result: ExtractResult, updateUserAgent: Boolean = true): ExtractResult {
        ObaflixApp.playerState.resetCdnHosts(URL(result.stream).host)
        ObaflixApp.playerState.embedReferer = result.referer
        if (updateUserAgent) ObaflixApp.playerState.mediaUserAgent = result.userAgent
        return result
    }

    suspend fun acceptNativeResult(nativeResult: NativeExtractResult): ExtractResult =
        applyToPlayback(resultOnly(nativeResult))

    suspend fun extract(embedUrl: String): ExtractResult = applyToPlayback(extractResult(embedUrl))

    suspend fun extractResult(embedUrl: String): ExtractResult {
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

        return resultOnly(nativeResult)
    }
}
