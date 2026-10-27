package com.nuvio.app.integration.obaflix

import co.touchlab.kermit.Logger
import com.nuvio.app.core.ui.NuvioToastController
import com.nuvio.app.features.servers.ServerException
import com.nuvio.app.features.streams.StreamItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * "Transmitir" and "Baixar" for Obaflix titles, the way the published (WebView) app does them: ONE tap, ONE ad when the
 * server asks for it, then the Obaflix servers themselves are resolved and the first one that works is used. No source list
 * is opened and no addon is queried (they are playback-only). The server sources are the "fontes nativas": the list comes
 * from `/api/player/fontes` under the action's own purpose (`transmissao` / `download`), so the grant the ad paid for is the
 * one consumed there; later servers are tried with the same grant, never with a second ad.
 */
internal object ObaflixNativeActions {
    private const val MAX_SERVERS = 3
    private val log = Logger.withTag("ObaflixActions")

    /** Process-wide and independent of the screen: the full-screen ad can recreate the Activity and the action must still finish. */
    internal var scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    @kotlin.concurrent.Volatile
    private var running = false

    /** Seams, replaced in tests. */
    internal var serversFor: suspend (ObaflixRef, String) -> List<StreamItem> = { ref, purpose -> ObaflixNativeSources.listForAction(ref, purpose) }
    internal var prepare: suspend (StreamItem) -> StreamItem = { ObaflixNativeSources.prepare(it) }

    fun cast(videoId: String, title: String, poster: String?) = launchOnce { castNow(videoId, title, poster) }

    fun download(videoId: String, enqueue: suspend (StreamItem) -> Boolean) = launchOnce { downloadNow(videoId, enqueue) }

    private fun launchOnce(block: suspend () -> Unit) {
        if (running) return // a second tap while one action is still being prepared
        running = true
        scope.launch {
            try {
                block()
            } finally {
                running = false
            }
        }
    }

    internal suspend fun castNow(videoId: String, title: String, poster: String?) {
        val ref = ObaflixRef.parse(videoId) ?: return NuvioToastController.show("Conteúdo inválido.")
        // The cast app is checked before any ad is asked for an action that cannot happen.
        when (ObaflixCast.verificarApp?.invoke()) {
            ObaflixCastResult.STORE_OPENED -> return NuvioToastController.show("Instale o Web Video Cast para transmitir para a TV.")
            ObaflixCastResult.UNAVAILABLE -> return NuvioToastController.show("Transmissão indisponível neste aparelho.")
            else -> Unit
        }
        val servers = authorizedServers(ref, ObaflixPlaybackGate.TRANSMISSAO) ?: return
        for (server in servers.take(MAX_SERVERS)) {
            val playable = prepared(server) ?: continue
            val request = ObaflixCast.requestFor(playable, title, poster) ?: continue
            if (!ObaflixSourceProbe.reachable(request.url, request.headers)) {
                log.i { "cast: servidor sem resposta" }
                continue
            }
            val result = ObaflixCast.handoff?.invoke(request) ?: ObaflixCastResult.UNAVAILABLE
            log.i { "cast: entrega=$result" }
            when (result) {
                ObaflixCastResult.OPENED -> return
                ObaflixCastResult.STORE_OPENED -> return NuvioToastController.show("Instale o Web Video Cast para transmitir para a TV.")
                ObaflixCastResult.UNAVAILABLE -> return NuvioToastController.show("Transmissão indisponível neste aparelho.")
            }
        }
        NuvioToastController.show("Não foi possível preparar um servidor para transmitir. Tente novamente em instantes.")
    }

    internal suspend fun downloadNow(videoId: String, enqueue: suspend (StreamItem) -> Boolean) {
        val ref = ObaflixRef.parse(videoId) ?: return NuvioToastController.show("Conteúdo inválido.")
        val servers = authorizedServers(ref, ObaflixPlaybackGate.DOWNLOAD) ?: return
        var onlyStreams = true
        for (server in servers.take(MAX_SERVERS)) {
            val playable = prepared(server) ?: continue
            val url = playable.playableDirectUrl ?: continue
            // Only plain files are downloadable: a stream (HLS) is skipped, a direct file is preferred over it.
            if (playable.streamType.equals("hls", true) || ObaflixNativeSources.looksHls(url)) continue
            onlyStreams = false
            val headers = playable.behaviorHints.proxyHeaders?.request.orEmpty()
            if (!ObaflixSourceProbe.reachable(url, headers)) {
                log.i { "download: servidor sem resposta" }
                continue
            }
            if (enqueue(playable)) {
                log.i { "download: iniciado" }
                return
            }
        }
        NuvioToastController.show(
            if (onlyStreams && servers.isNotEmpty()) "Os servidores deste título só oferecem transmissão ao vivo, que não pode ser baixada."
            else "Não foi possível iniciar o download. Tente novamente em instantes.",
        )
    }

    /** The ad (once, when the server asks) and the server list under the action's purpose. Null after telling the user why. */
    private suspend fun authorizedServers(ref: ObaflixRef, purpose: String): List<StreamItem>? {
        NuvioToastController.show(if (purpose == ObaflixPlaybackGate.DOWNLOAD) "Preparando o download…" else "Preparando a transmissão…")
        val decision = ObaflixPlaybackGate.renew(ref, purpose)
        log.i { "$purpose: autorizacao=${decision::class.simpleName}" }
        if (decision is GateDecision.Blocked) {
            NuvioToastController.show(decision.message)
            return null
        }
        val servers = try {
            serversFor(ref, purpose)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ServerException) {
            NuvioToastController.show(e.message ?: "Não foi possível carregar os servidores. Tente novamente.")
            return null
        } catch (_: Exception) {
            NuvioToastController.show("Não foi possível carregar os servidores. Tente novamente.")
            return null
        }
        if (servers.isEmpty()) {
            NuvioToastController.show("Nenhum servidor disponível para este título.")
            return null
        }
        return servers
    }

    private suspend fun prepared(server: StreamItem): StreamItem? = try {
        prepare(server)
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null // this server did not yield media: the next one is tried with the same authorization
    }
}
