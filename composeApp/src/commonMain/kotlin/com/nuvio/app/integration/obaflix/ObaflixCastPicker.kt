package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.streams.StreamItem

/**
 * Picks the source "Transmitir" hands to the cast app, so the user never has to choose a server.
 *
 * A source is *proven* castable only when everything the cast app needs is visible before the ad: public `https`
 * media (the same rule [ObaflixCast.requestFor] enforces, `secure_uri`), a known container (mp4 or HLS), nothing that
 * must be resolved or unlocked on this device (debrid, torrent, client resolve, "not web ready") and no request header
 * the cast app cannot repeat (it only gets Referer and User-Agent). A URL is never accepted just for existing.
 * `http` is never upgraded and never proxied: it is reported, not used.
 *
 * Obaflix's own servers need a server session before they yield a URL, so they cannot be proven up front; they are a
 * second tier, tried only after every proven source.
 */
internal object ObaflixCastPicker {
    enum class Tier { PROVEN, OWN_SERVER }

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
            if (!knownContainer(stream, url)) continue
            if (url.startsWith("http://", ignoreCase = true)) {
                insecure = true
                continue
            }
            val headers = stream.behaviorHints.proxyHeaders?.request.orEmpty()
            if (headers.keys.any { it.lowercase() !in ALLOWED_HEADERS }) continue
            if (ObaflixCast.requestFor(stream, title, poster) == null) continue
            found += Candidate(stream, Tier.PROVEN, quality(stream))
        }
        // Stable sort: ties keep the order the addons were listed in, so no single provider is hard-wired.
        val ordered = found.sortedWith(compareBy<Candidate>({ it.tier }, { -it.quality }))
        return Ranking(ordered, onlyInsecure = insecure && ordered.none { it.tier == Tier.PROVEN })
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
