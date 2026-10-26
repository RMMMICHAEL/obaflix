package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.streams.StreamItem

/**
 * Picks the source "Transmitir" hands to the cast app, so the user never has to choose a server.
 *
 * Order of preference: (1) `https` with a known container (mp4 / HLS); (2) `https` with an unknown container, which the
 * reachability probe ([ObaflixSourceProbe]) must still confirm as media; (3) Obaflix's own servers, which need a server
 * session before they yield a URL; (4) `http`, only as the last resort when nothing safer exists (some providers, e.g.
 * FenixFlix, serve only `http`). `http` is never upgraded and never proxied, and a source is never accepted just for
 * existing: the caller probes each one and falls through to the next. Nothing that must be resolved or unlocked on this
 * device (debrid, torrent, client resolve, "not web ready") and no request header the cast app cannot repeat (it only
 * gets Referer and User-Agent) is ever a candidate.
 */
internal object ObaflixCastPicker {
    enum class Tier { PROVEN, UNKNOWN_CONTAINER, OWN_SERVER, INSECURE }

    data class Candidate(val stream: StreamItem, val tier: Tier, val quality: Int)

    data class Ranking(val candidates: List<Candidate>, val onlyInsecure: Boolean)

    private val ALLOWED_HEADERS = setOf("referer", "user-agent")

    fun rank(
        streams: List<StreamItem>,
        title: String,
        poster: String?,
        ownServer: (StreamItem) -> Boolean = { ObaflixNative.isNative(it) && it.needsServerPreparation },
    ): Ranking {
        val found = mutableListOf<Candidate>()
        var insecure = false
        for (stream in streams) {
            if (ownServer(stream)) {
                found += Candidate(stream, Tier.OWN_SERVER, quality(stream))
                continue
            }
            val url = stream.playableDirectUrl ?: continue
            if (stream.clientResolve != null || stream.isTorrentStream || stream.behaviorHints.notWebReady) continue
            val headers = stream.behaviorHints.proxyHeaders?.request.orEmpty()
            if (headers.keys.any { it.lowercase() !in ALLOWED_HEADERS }) continue
            val isHttp = url.startsWith("http://", ignoreCase = true)
            if (ObaflixCast.requestFor(stream, title, poster, allowInsecure = isHttp) == null) continue
            if (isHttp) {
                insecure = true
                found += Candidate(stream, Tier.INSECURE, quality(stream))
            } else {
                found += Candidate(stream, if (knownContainer(stream, url)) Tier.PROVEN else Tier.UNKNOWN_CONTAINER, quality(stream))
            }
        }
        // Stable sort: ties keep the order the addons were listed in, so no single provider is hard-wired.
        val ordered = found.sortedWith(compareBy<Candidate>({ it.tier }, { -it.quality }))
        return Ranking(ordered, onlyInsecure = insecure && ordered.all { it.tier == Tier.INSECURE })
    }

    private fun knownContainer(stream: StreamItem, url: String): Boolean {
        val path = url.substringBefore('?').substringBefore('#').lowercase()
        return stream.streamType.equals("hls", true) || path.endsWith(".m3u8") || path.endsWith(".mp4")
    }

    /** 2160/1440/1080/720/480 from the labels the addons put on a source; 0 when unknown. */
    internal fun quality(stream: StreamItem): Int {
        val text = listOfNotNull(stream.name, stream.title, stream.description).joinToString(" ").lowercase()
        return when {
            "2160" in text || "4k" in text -> 2160
            "1440" in text -> 1440
            "1080" in text -> 1080
            "720" in text -> 720
            "480" in text -> 480
            else -> 0
        }
    }
}
