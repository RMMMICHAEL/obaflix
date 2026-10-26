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
