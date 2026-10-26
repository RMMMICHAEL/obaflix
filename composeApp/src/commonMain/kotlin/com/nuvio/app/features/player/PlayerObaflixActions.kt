package com.nuvio.app.features.player

import com.nuvio.app.core.ui.NuvioToastController
import com.nuvio.app.features.downloads.DownloadsRepository
import com.nuvio.app.features.streams.StreamBehaviorHints
import com.nuvio.app.features.streams.StreamItem
import com.nuvio.app.features.streams.StreamProxyHeaders
import com.nuvio.app.integration.obaflix.obaflixCastGate
import com.nuvio.app.integration.obaflix.obaflixDownloadGate

/** The source on screen, even when the player was opened straight from a URL. */
private fun PlayerScreenRuntime.currentStream(): StreamItem? =
    activeStream ?: activeSourceUrl.takeIf { it.isNotBlank() }?.let { url ->
        StreamItem(
            url = url,
            addonName = activeProviderName,
            addonId = activeProviderAddonId.orEmpty(),
            streamType = activeStreamType,
            behaviorHints = StreamBehaviorHints(proxyHeaders = StreamProxyHeaders(request = activeSourceHeaders)),
        )
    }

/** "Baixar" in the player: the same download action and Obaflix `download` authorization as the source list. */
internal fun PlayerScreenRuntime.downloadCurrentSource() {
    val stream = currentStream() ?: return
    val videoId = activeVideoId ?: return
    obaflixDownloadGate(videoId, scope) { source ->
        val result = DownloadsRepository.enqueueFromStream(
            contentType = contentType ?: parentMetaType,
            videoId = videoId,
            parentMetaId = parentMetaId,
            parentMetaType = parentMetaType,
            title = title,
            logo = logo,
            poster = poster,
            background = background,
            seasonNumber = activeSeasonNumber,
            episodeNumber = activeEpisodeNumber,
            episodeTitle = activeEpisodeTitle,
            episodeThumbnail = null,
            stream = source,
        )
        NuvioToastController.show(result.toastMessage())
    }(stream)
}

/** "Transmitir" in the player: hands the source on screen to the cast app after `transmissao` authorization. */
internal fun PlayerScreenRuntime.castCurrentSource() {
    val stream = currentStream() ?: return
    val videoId = activeVideoId ?: return
    obaflixCastGate(videoId = videoId, title = title, poster = poster ?: background, scope = scope)(stream)
}
