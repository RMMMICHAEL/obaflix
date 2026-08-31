// Tudo que este arquivo toca do Media3 e API instavel (AnalyticsListener,
// LoadEventInfo, MediaLoadData, Format). Optar no arquivo evita repetir a
// anotacao em cada metodo.
@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package com.obaflix.tv.player

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.LoadEventInfo
import androidx.media3.exoplayer.source.MediaLoadData
import com.obaflix.bridge.ObaLog
import java.io.IOException

/**
 * O que o Media3 fez, e nao so o que ele disse no fim.
 *
 * O log ate aqui contava a historia ate "entreguei a URL ao player" e depois
 * pulava direto para "a fonte nao iniciou". Tudo que interessa acontece nesse
 * vao: o master responde, a variante responde, o primeiro segmento leva 403, o
 * decodificador do aparelho recusa o codec. Sem ver as requisicoes que o
 * proprio player faz, cada falha virava adivinhacao — e foi assim que "Servidor
 * 6 da 404" ficou semanas sem explicacao, porque nao dava para saber se o 404
 * era do master ou de um segmento.
 *
 * O que **nao** entra aqui: URL completa, querystring, token, cookie. Host e
 * nome do arquivo bastam para saber em que passo do HLS a coisa quebrou, e sao
 * o que se pode colar num chat sem entregar um link assinado.
 */
class DiagnosticoPlayer(private val rotuloFonte: () -> String) : AnalyticsListener {

    /**
     * Segmentos ja registrados nesta fonte.
     *
     * Um episodio de 40 minutos pede centenas de segmentos. Registrar todos
     * afogaria o log justamente no trecho que interessa — os primeiros
     * segundos. Os primeiros [SEGMENTOS_INTEIROS] saem inteiros, e depois um a
     * cada [AMOSTRAGEM]; erro sempre sai.
     */
    private var segmentos = 0

    /** Zerado a cada fonte nova, para a amostragem recomecar do zero. */
    fun novaFonte() {
        segmentos = 0
    }

    // ── Requisicoes que o player faz ─────────────────────────────────────────

    override fun onLoadCompleted(
        eventTime: AnalyticsListener.EventTime,
        loadEventInfo: LoadEventInfo,
        mediaLoadData: MediaLoadData,
    ) {
        val tipo = nomeDoTipo(mediaLoadData.dataType)
        // Playlist e manifesto sao poucos e decidem tudo: sempre saem.
        val ehSegmento = mediaLoadData.dataType == C.DATA_TYPE_MEDIA
        if (ehSegmento) {
            segmentos++
            if (segmentos > SEGMENTOS_INTEIROS && segmentos % AMOSTRAGEM != 0) return
        }
        ObaLog.evento(
            ObaLog.Fase.CDN, "tv_carga_ok",
            "servidor" to rotuloFonte(),
            "tipo" to tipo,
            "faixa" to nomeDaFaixa(mediaLoadData.trackType),
            "host" to ObaLog.host(loadEventInfo.uri.toString()),
            "arquivo" to ObaLog.arquivo(loadEventInfo.uri.toString()),
            "bytes" to loadEventInfo.bytesLoaded,
            "ms" to loadEventInfo.loadDurationMs,
            "n" to (if (ehSegmento) segmentos else null),
        )
    }

    override fun onLoadError(
        eventTime: AnalyticsListener.EventTime,
        loadEventInfo: LoadEventInfo,
        mediaLoadData: MediaLoadData,
        error: IOException,
        wasCanceled: Boolean,
    ) {
        // O status HTTP e a unica coisa que distingue "link morto" de "faltou
        // cabecalho" de "CDN recusou o IP". Sem ele, todo erro de rede tem a
        // mesma cara.
        val status = (error as? HttpDataSource.InvalidResponseCodeException)?.responseCode
        ObaLog.alerta(
            ObaLog.Fase.CDN, "tv_carga_falhou",
            "servidor" to rotuloFonte(),
            "tipo" to nomeDoTipo(mediaLoadData.dataType),
            "faixa" to nomeDaFaixa(mediaLoadData.trackType),
            "host" to ObaLog.host(loadEventInfo.uri.toString()),
            "arquivo" to ObaLog.arquivo(loadEventInfo.uri.toString()),
            "status" to status,
            // Quem respondeu o erro. Um 404 vindo do proprio provedor e um 404
            // vindo da borda do CDN pedem correcoes opostas, e sem estes dois
            // cabecalhos os dois sao a mesma linha de log.
            "servidorCdn" to cabecalho(loadEventInfo, "Server"),
            "tipoConteudo" to cabecalho(loadEventInfo, "Content-Type"),
            "erro" to error.javaClass.simpleName,
            "causa" to ObaLog.texto(error.message),
            "cancelado" to wasCanceled,
            "ms" to loadEventInfo.loadDurationMs,
        )
    }

    // ── Formato e decodificador ──────────────────────────────────────────────

    override fun onVideoInputFormatChanged(
        eventTime: AnalyticsListener.EventTime,
        format: Format,
        decoderReuseEvaluation: androidx.media3.exoplayer.DecoderReuseEvaluation?,
    ) {
        ObaLog.evento(
            ObaLog.Fase.RENDER, "tv_formato_video",
            "servidor" to rotuloFonte(),
            "mime" to format.sampleMimeType,
            "codecs" to format.codecs,
            "tamanho" to (format.width.toString() + "x" + format.height),
            "fps" to format.frameRate.takeIf { it > 0 },
            "kbps" to (format.bitrate.takeIf { it > 0 }?.div(1000)),
        )
    }

    override fun onAudioInputFormatChanged(
        eventTime: AnalyticsListener.EventTime,
        format: Format,
        decoderReuseEvaluation: androidx.media3.exoplayer.DecoderReuseEvaluation?,
    ) {
        ObaLog.evento(
            ObaLog.Fase.RENDER, "tv_formato_audio",
            "servidor" to rotuloFonte(),
            "mime" to format.sampleMimeType,
            "codecs" to format.codecs,
            "canais" to format.channelCount.takeIf { it > 0 },
            "idioma" to format.language,
        )
    }

    /**
     * Qual decodificador o aparelho escolheu.
     *
     * `OMX.google.*` e `c2.android.*` sao software; o resto e do fabricante.
     * Numa falha de decodificacao esta linha responde de imediato se o plano B
     * por software chegou a entrar — que e a diferenca entre "o aparelho nao
     * aguenta" e "o aparelho nem tentou".
     */
    override fun onVideoDecoderInitialized(
        eventTime: AnalyticsListener.EventTime,
        decoderName: String,
        initializedTimestampMs: Long,
        initializationDurationMs: Long,
    ) {
        ObaLog.evento(
            ObaLog.Fase.RENDER, "tv_decoder_video",
            "servidor" to rotuloFonte(),
            "decoder" to decoderName,
            "software" to ehSoftware(decoderName),
            "ms" to initializationDurationMs,
        )
    }

    override fun onAudioDecoderInitialized(
        eventTime: AnalyticsListener.EventTime,
        decoderName: String,
        initializedTimestampMs: Long,
        initializationDurationMs: Long,
    ) {
        ObaLog.evento(
            ObaLog.Fase.RENDER, "tv_decoder_audio",
            "servidor" to rotuloFonte(),
            "decoder" to decoderName,
            "software" to ehSoftware(decoderName),
        )
    }

    // ── Saude da reproducao ──────────────────────────────────────────────────

    override fun onRenderedFirstFrame(
        eventTime: AnalyticsListener.EventTime,
        output: Any,
        renderTimeMs: Long,
    ) {
        ObaLog.evento(
            ObaLog.Fase.RENDER, "tv_primeiro_quadro",
            "servidor" to rotuloFonte(),
            // `eventTime.realtimeMs` e o elapsedRealtime do aparelho, nao um
            // tempo relativo: saia como "desdeOInicioMs=4940143", que nao
            // queria dizer nada. O "+NNNNms" que o ObaLog ja poe em toda linha
            // e o tempo desta tentativa, e e esse que interessa.
            "renderMs" to renderTimeMs,
        )
    }

    /**
     * Quadros descartados.
     *
     * Em TV Box fraca este e o sinal que separa "a fonte esta ruim" de "o
     * aparelho nao da conta desta resolucao" — dois problemas com a mesma
     * aparencia na tela e solucoes opostas.
     */
    override fun onDroppedVideoFrames(
        eventTime: AnalyticsListener.EventTime,
        droppedFrames: Int,
        elapsedMs: Long,
    ) {
        ObaLog.alerta(
            ObaLog.Fase.RENDER, "tv_quadros_perdidos",
            "servidor" to rotuloFonte(),
            "quadros" to droppedFrames,
            "emMs" to elapsedMs,
        )
    }

    override fun onPlaybackStateChanged(eventTime: AnalyticsListener.EventTime, state: Int) {
        ObaLog.evento(
            ObaLog.Fase.PLAYER, "tv_estado",
            "servidor" to rotuloFonte(),
            "estado" to when (state) {
                Player.STATE_IDLE -> "IDLE"
                Player.STATE_BUFFERING -> "BUFFERING"
                Player.STATE_READY -> "READY"
                Player.STATE_ENDED -> "ENDED"
                else -> state.toString()
            },
        )
    }

    override fun onPlayerError(
        eventTime: AnalyticsListener.EventTime,
        error: PlaybackException,
    ) {
        // Nivel de falha: alem da linha, o ObaLog reimprime a trilha inteira
        // desta tentativa em bloco. E o momento em que o que veio antes deixa
        // de ser opcional.
        ObaLog.falha(
            ObaLog.Fase.PLAYER, "tv_erro_media3", error,
            "servidor" to rotuloFonte(),
            "codigo" to error.errorCodeName,
        )
    }

    // ── Nomes ────────────────────────────────────────────────────────────────

    private fun nomeDoTipo(dataType: Int): String = when (dataType) {
        C.DATA_TYPE_MANIFEST -> "playlist"
        C.DATA_TYPE_MEDIA -> "segmento"
        C.DATA_TYPE_MEDIA_INITIALIZATION -> "init"
        C.DATA_TYPE_DRM -> "drm"
        C.DATA_TYPE_TIME_SYNCHRONIZATION -> "relogio"
        else -> "outro" + dataType
    }

    private fun nomeDaFaixa(trackType: Int): String = when (trackType) {
        C.TRACK_TYPE_VIDEO -> "video"
        C.TRACK_TYPE_AUDIO -> "audio"
        C.TRACK_TYPE_TEXT -> "legenda"
        C.TRACK_TYPE_DEFAULT -> "-"
        // -1 e TRACK_TYPE_UNKNOWN, que e o que uma playlist reporta antes de
        // haver faixa: aparecia como "t-1" e parecia defeito.
        C.TRACK_TYPE_UNKNOWN -> "-"
        else -> "t" + trackType
    }

    /** Um cabecalho da resposta, quando o Media3 chegou a receber cabecalhos. */
    private fun cabecalho(info: LoadEventInfo, nome: String): String? =
        info.responseHeaders[nome]?.firstOrNull()
            ?: info.responseHeaders.entries
                .firstOrNull { it.key.equals(nome, ignoreCase = true) }
                ?.value?.firstOrNull()

    private fun ehSoftware(decoder: String): Boolean =
        decoder.startsWith("OMX.google.", ignoreCase = true) ||
            decoder.startsWith("c2.android.", ignoreCase = true)

    private companion object {
        const val SEGMENTOS_INTEIROS = 4
        const val AMOSTRAGEM = 25
    }
}
