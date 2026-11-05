package com.nuvio.app.integration.obaflix

import co.touchlab.kermit.Logger
import com.nuvio.app.core.ui.NuvioToastController
import com.nuvio.app.features.streams.StreamItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Download of Obaflix content is its own purpose (`finalidade: download`): authorized per action,
 * possibly with its own ad, never inherited from a playback grant. Other content is untouched.
 */
internal fun obaflixDownloadGate(
    videoId: String,
    scope: CoroutineScope,
    start: (StreamItem) -> Unit,
): (StreamItem) -> Unit {
    val ref = ObaflixRef.parse(videoId) ?: return start
    return { stream ->
        // Detached from the screen's job: the full-screen ad can recreate the Activity, and the download must still start.
        scope.launch(kotlinx.coroutines.NonCancellable) {
            when {
                // The Obaflix server session is opened for playback only.
                ObaflixNative.isNative(stream) ->
                    NuvioToastController.show("Download pelos servidores Obaflix ainda não está disponível nesta versão.")
                else -> when (val decision = ObaflixPlaybackGate.renew(ref, ObaflixPlaybackGate.DOWNLOAD)) {
                    is GateDecision.Blocked -> {
                        Logger.withTag("ObaflixActions").i { "download: bloqueado (${decision.message})" }
                        NuvioToastController.show(decision.message)
                    }
                    else -> {
                        Logger.withTag("ObaflixActions").i { "download: autorizado, iniciando" }
                        start(stream)
                    }
                }
            }
        }
    }
}

/**
 * Picks the sources "Baixar" tries, so the user never has to choose one. Only plain files can be downloaded (no HLS/DASH/
 * torrent/magnet) and Obaflix's own server sessions are playback-only. `https` first, best labelled quality first, ties in
 * the listed order; `http` only after every `https` source, as the last resort (never upgraded or proxied).
 */
internal object ObaflixDownloadPicker {
    fun rank(streams: List<StreamItem>): List<StreamItem> {
        val usable = streams.filter { s ->
            val url = s.playableDirectUrl?.trim()?.lowercase() ?: return@filter false
            val path = url.substringBefore('?').substringBefore('#')
            (url.startsWith("https://") || url.startsWith("http://")) &&
                s.clientResolve == null && !s.isTorrentStream && !s.behaviorHints.notWebReady && !ObaflixNative.isNative(s) &&
                !path.endsWith(".m3u8") && !path.endsWith(".mpd") && !path.endsWith(".torrent")
        }
        return usable.sortedWith(compareBy<StreamItem>({ if (it.playableDirectUrl!!.trim().startsWith("https://", true)) 0 else 1 }, { -ObaflixCastPicker.quality(it) }))
    }
}

private const val MAX_AUTO_DOWNLOAD_TRIES = 5

/**
 * "Baixar" without choosing a server: ranks the loaded sources, asks for the ad the server requires (once), then tries
 * the best sources in order, starting the first one that really answers as media. [enqueue] must return true only when
 * the download was queued. A refused or cancelled ad stops everything and never asks a second one.
 */
internal fun obaflixAutoDownload(
    videoId: String,
    scope: CoroutineScope,
    enqueue: suspend (StreamItem) -> Boolean,
): (List<StreamItem>) -> Unit = { streams ->
    // Detached from the screen's job: the full-screen ad can recreate the Activity, and the download must still start.
    scope.launch(kotlinx.coroutines.NonCancellable) {
        val log = Logger.withTag("ObaflixActions")
        val candidates = ObaflixDownloadPicker.rank(streams)
        log.i { "download auto: ${streams.size} fontes, ${candidates.size} baixaveis" }
        if (candidates.isEmpty()) {
            NuvioToastController.show("Nenhuma fonte disponível para baixar este título.")
            return@launch
        }
        val ref = ObaflixRef.parse(videoId)
        if (ref != null) {
            val decision = ObaflixPlaybackGate.renew(ref, ObaflixPlaybackGate.DOWNLOAD)
            log.i { "download auto: autorizacao=${decision::class.simpleName}" }
            if (decision is GateDecision.Blocked) {
                NuvioToastController.show(decision.message)
                return@launch
            }
        }
        for (stream in candidates.take(MAX_AUTO_DOWNLOAD_TRIES)) {
            val url = stream.playableDirectUrl ?: continue
            val headers = stream.behaviorHints.proxyHeaders?.request.orEmpty()
            if (!ObaflixSourceProbe.reachable(url, headers)) {
                log.i { "download auto: fonte indisponivel" }
                continue
            }
            if (enqueue(stream)) {
                log.i { "download auto: iniciado" }
                return@launch
            }
        }
        NuvioToastController.show("Não foi possível iniciar o download. Tente novamente em instantes.")
    }
}
