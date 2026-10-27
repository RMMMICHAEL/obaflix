package com.nuvio.app.integration.obaflix

import com.nuvio.app.core.ui.NuvioToastController
import com.nuvio.app.features.servers.ServerPlayback
import com.nuvio.app.features.streams.StreamItem
import co.touchlab.kermit.Logger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * One-shot action chosen on the details page ("Baixar" / "Transmitir"): the next source list opens
 * in that mode (no autoplay) and a tapped source runs the action instead of playing.
 */
object ObaflixStreamAction {
    const val DOWNLOAD = "download"
    const val CAST = "cast"

    private var pending: String? = null

    fun request(action: String) {
        pending = action
    }

    fun consume(): String? = pending.also { pending = null }
}

/** What the device hands to the cast app (official app: Web Video Cast intent). */
data class ObaflixCastRequest(
    val url: String,
    val headers: Map<String, String>,
    val isHls: Boolean,
    val title: String,
    val poster: String?,
)

enum class ObaflixCastResult { OPENED, STORE_OPENED, UNAVAILABLE }

private val actionLog = Logger.withTag("ObaflixActions")

object ObaflixCast {
    /**
     * Set by the Android application: is the cast app installed? When it is not, this already opens the Play Store (or the
     * browser page) and returns [ObaflixCastResult.STORE_OPENED]; [ObaflixCastResult.OPENED] means "installed, go on".
     * Null where there is no cast app to check (tests, other platforms): nothing is asked.
     */
    internal var verificarApp: (() -> ObaflixCastResult)? = null

    /** Set by the Android application (same contract as android/app cast/WebVideoCast.kt). */
    internal var handoff: ((ObaflixCastRequest) -> ObaflixCastResult)? = null

    /** Public, playable https media; `http` only when the caller asks for it as the last resort (never upgraded or proxied). */
    internal fun requestFor(stream: StreamItem, title: String, poster: String?, allowInsecure: Boolean = false): ObaflixCastRequest? {
        val url = stream.playableDirectUrl?.takeIf { it.startsWith("https://") || (allowInsecure && it.startsWith("http://")) } ?: return null
        val headers = stream.behaviorHints.proxyHeaders?.request.orEmpty()
            .filterKeys { it.equals("Referer", true) || it.equals("User-Agent", true) }
        val isHls = stream.streamType.equals("hls", true) || url.substringBefore('?').lowercase().endsWith(".m3u8")
        return ObaflixCastRequest(url, headers, isHls, title, poster?.takeIf { it.startsWith("https://") })
    }
}

/**
 * "Transmitir": its own purpose (`transmissao`) authorized per action, possibly with its own ad, like
 * download. Obaflix servers are resolved through the normal path first. Other content: no gate.
 */
internal fun obaflixCastGate(
    videoId: String,
    title: String,
    poster: String?,
    scope: CoroutineScope,
): (StreamItem) -> Unit = { stream ->
    // Detached from the screen's job: the full-screen ad can recreate the Activity, and the hand-off must still happen.
    scope.launch(NonCancellable) {
        // Availability first: no ad is asked for an action that cannot happen (cast app missing, source not castable).
        when (ObaflixCast.verificarApp?.invoke()) {
            ObaflixCastResult.STORE_OPENED -> {
                NuvioToastController.show("Instale o Web Video Cast para transmitir para a TV.")
                return@launch
            }
            ObaflixCastResult.UNAVAILABLE -> {
                NuvioToastController.show("Transmissão indisponível neste aparelho.")
                return@launch
            }
            else -> Unit
        }
        if (!stream.needsServerPreparation && ObaflixCast.requestFor(stream, title, poster, allowInsecure = true) == null) {
            NuvioToastController.show("Esta fonte não pode ser transmitida. Escolha outra.")
            return@launch
        }
        val ref = ObaflixRef.parse(videoId)
        if (ref != null) {
            val decision = ObaflixPlaybackGate.renew(ref, ObaflixPlaybackGate.TRANSMISSAO)
            actionLog.i { "cast manual: autorizacao=${decision::class.simpleName}" }
            if (decision is GateDecision.Blocked) {
                NuvioToastController.show(decision.message)
                return@launch
            }
        }
        val playable = if (stream.needsServerPreparation) {
            try {
                ServerPlayback.prepare(stream)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                NuvioToastController.show("Não foi possível preparar esta fonte para transmitir.")
                return@launch
            }
        } else {
            stream
        }
        val request = ObaflixCast.requestFor(playable, title, poster, allowInsecure = true) // the user picked this source
        if (request == null) {
            NuvioToastController.show("Esta fonte não pode ser transmitida. Escolha outra.")
            return@launch
        }
        val handoffResult = ObaflixCast.handoff?.invoke(request) ?: ObaflixCastResult.UNAVAILABLE
        actionLog.i { "cast manual: entrega=$handoffResult" }
        when (handoffResult) {
            ObaflixCastResult.OPENED -> Unit
            ObaflixCastResult.STORE_OPENED ->
                NuvioToastController.show("Instale o Web Video Cast para transmitir para a TV.")
            ObaflixCastResult.UNAVAILABLE ->
                NuvioToastController.show("Transmissão indisponível neste aparelho.")
        }
    }
}

/**
 * "Transmitir" without choosing a server: ranks the loaded sources ([ObaflixCastPicker]), checks the cast app, asks for
 * the ad the server requires (once), and only then hands the best source over. With no compatible source or no cast app
 * nothing is authorized and no ad is asked. After the ad, at most [MAX_AUTO_CAST_TRIES] sources are tried, never a second ad.
 */
internal fun obaflixAutoCast(
    videoId: String,
    title: String,
    poster: String?,
    scope: CoroutineScope,
): (List<StreamItem>) -> Unit = { streams ->
    // Detached from the screen's job: the full-screen ad can recreate the Activity, and the hand-off must still happen.
    scope.launch(NonCancellable) {
        val ranking = ObaflixCastPicker.rank(streams, title, poster)
        actionLog.i { "cast auto: ${streams.size} fontes, ${ranking.candidates.size} compativeis, soHttp=${ranking.onlyInsecure}" }
        if (ranking.candidates.isEmpty()) {
            NuvioToastController.show("Nenhuma fonte compatível com a transmissão foi encontrada para este título.")
            return@launch
        }
        when (ObaflixCast.verificarApp?.invoke()) {
            ObaflixCastResult.STORE_OPENED -> {
                NuvioToastController.show("Instale o Web Video Cast para transmitir para a TV.")
                return@launch
            }
            ObaflixCastResult.UNAVAILABLE -> {
                NuvioToastController.show("Transmissão indisponível neste aparelho.")
                return@launch
            }
            else -> Unit
        }
        val ref = ObaflixRef.parse(videoId)
        if (ref != null) {
            val decision = ObaflixPlaybackGate.renew(ref, ObaflixPlaybackGate.TRANSMISSAO)
            actionLog.i { "cast auto: autorizacao=${decision::class.simpleName} ${(decision as? GateDecision.Blocked)?.message.orEmpty()}" }
            if (decision is GateDecision.Blocked) {
                NuvioToastController.show(decision.message)
                return@launch
            }
        }
        for (candidate in ranking.candidates.take(MAX_AUTO_CAST_TRIES)) {
            val playable = if (candidate.stream.needsServerPreparation) {
                try {
                    ServerPlayback.prepare(candidate.stream)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    continue
                }
            } else {
                candidate.stream
            }
            val request = ObaflixCast.requestFor(playable, title, poster, allowInsecure = candidate.tier == ObaflixCastPicker.Tier.INSECURE) ?: continue
            // The ad is already paid: a source that does not answer like media is skipped, never handed to the TV.
            if (!ObaflixSourceProbe.reachable(request.url, request.headers)) {
                actionLog.i { "cast auto: fonte indisponivel tier=${candidate.tier}" }
                continue
            }
            val handoffResult = ObaflixCast.handoff?.invoke(request) ?: ObaflixCastResult.UNAVAILABLE
            actionLog.i { "cast auto: entrega=$handoffResult tier=${candidate.tier}" }
            when (handoffResult) {
                ObaflixCastResult.OPENED -> return@launch
                ObaflixCastResult.STORE_OPENED -> {
                    NuvioToastController.show("Instale o Web Video Cast para transmitir para a TV.")
                    return@launch
                }
                ObaflixCastResult.UNAVAILABLE -> {
                    NuvioToastController.show("Transmissão indisponível neste aparelho.")
                    return@launch
                }
            }
        }
        NuvioToastController.show("Não foi possível preparar uma fonte para transmitir. Tente novamente.")
    }
}

private const val MAX_AUTO_CAST_TRIES = 5
