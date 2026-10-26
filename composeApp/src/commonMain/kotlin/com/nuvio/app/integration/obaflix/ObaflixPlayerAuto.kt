package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.details.MetaVideo
import com.nuvio.app.features.streams.StreamItem

/** Neighbour episodes for the player's previous/next buttons (the next one comes from the player's own aired check). */
internal object ObaflixEpisodeNav {
    fun previous(videos: List<MetaVideo>, season: Int?, episode: Int?): MetaVideo? {
        if (season == null || episode == null) return null
        val ordered = videos
            .filter { it.season != null && it.episode != null && (season == 0 || it.season!! > 0) }
            .sortedWith(compareBy<MetaVideo>({ it.season }, { it.episode }))
        val index = ordered.indexOfFirst { it.season == season && it.episode == episode }
        return if (index > 0) ordered[index - 1] else null
    }
}

/**
 * Picks the source an episode starts with when the user did not choose one (previous/next buttons, episode list), so
 * playback begins right after the ad. Own Obaflix servers first, then direct `https`, then direct `http`; higher quality
 * first, ties keep the listed order. Anything that must be resolved elsewhere (torrent, debrid, client resolve, "not web
 * ready") is never picked automatically: the user can still choose it from the list.
 */
internal object ObaflixPlaybackPicker {
    fun pick(
        streams: List<StreamItem>,
        ownServer: (StreamItem) -> Boolean = { ObaflixNative.isNative(it) && it.needsServerPreparation },
    ): StreamItem? {
        data class Scored(val stream: StreamItem, val tier: Int, val quality: Int)
        val scored = streams.mapNotNull { stream ->
            if (ownServer(stream)) return@mapNotNull Scored(stream, 0, ObaflixCastPicker.quality(stream))
            val url = stream.playableDirectUrl ?: return@mapNotNull null
            if (stream.clientResolve != null || stream.isTorrentStream || stream.behaviorHints.notWebReady) return@mapNotNull null
            val tier = if (url.startsWith("https://", ignoreCase = true)) 1 else if (url.startsWith("http://", ignoreCase = true)) 2 else return@mapNotNull null
            Scored(stream, tier, ObaflixCastPicker.quality(stream))
        }
        return scored.sortedWith(compareBy<Scored>({ it.tier }, { -it.quality })).firstOrNull()?.stream
    }
}
