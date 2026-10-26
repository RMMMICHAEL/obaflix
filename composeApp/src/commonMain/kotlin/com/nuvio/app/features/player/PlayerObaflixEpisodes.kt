package com.nuvio.app.features.player

import androidx.compose.runtime.snapshotFlow
import com.nuvio.app.features.details.MetaVideo
import com.nuvio.app.features.downloads.DownloadsRepository
import com.nuvio.app.integration.obaflix.ObaflixPlaybackPicker
import com.nuvio.app.integration.obaflix.withNetworkBudget
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Network budget for the source search; ad time (choice, shown, S2S confirmation) does not count against it. */
private const val EPISODE_AUTO_WAIT_MS = 60_000L

/** After the source is handed to the player: how long the "starting" screen waits for the first frame. */
private const val EPISODE_START_WAIT_MS = 45_000L

/**
 * Starts [episode] from the player without asking for a server. The loading screen of that episode appears at once and
 * the old playback is paused, before any ad; loading its sources runs the ad gate (the Rewarded choice is a layer over
 * this screen), and once authorized the best source is picked and played. One request at a time: the screen swallows
 * touches and a second call while one runs is ignored. A cancelled or refused ad, no sources, or a search that never
 * answers end on this screen with the reason and "Tentar novamente"; nothing is released and no ad is repeated (a
 * confirmed grant is reused by the server). The manual list opens only when sources exist but none is safe to pick alone.
 */
internal fun PlayerScreenRuntime.playEpisodeAutomatically(episode: MetaVideo) {
    if (episodeAutoJob?.isActive == true) return
    val shown = EpisodeSwitchUi(episode = episode, label = episodeSwitchLabel(episode))
    episodeSwitch = shown
    EpisodeSwitchResume.begin(parentMetaId, episode)
    showEpisodesPanel = false
    playerController?.pause()
    episodeAutoJob = scope.launch {
        fun fail(message: String) {
            EpisodeSwitchResume.clear()
            episodeSwitch = shown.copy(phase = EpisodeSwitchPhase.FAILED, message = message)
        }
        suspend fun finishAfterHandOff() {
            episodeSwitch = shown.copy(phase = EpisodeSwitchPhase.STARTING)
            // The old playback was paused for the switch: the new one must start by itself, never wait for a Play tap.
            playerController?.play()
            // The switch resets the load flag; wait for it to flip back (first frame) or fail, bounded.
            withTimeoutOrNull(3_000) { snapshotFlow { initialLoadCompleted }.first { !it } }
            withTimeoutOrNull(EPISODE_START_WAIT_MS) { snapshotFlow { initialLoadCompleted || errorMessage != null }.first { it } }
            if (errorMessage == null) playerController?.play()
            episodeSwitch = null
            EpisodeSwitchResume.clear()
        }

        val download = DownloadsRepository.findPlayableDownload(
            parentMetaId = parentMetaId,
            seasonNumber = episode.season,
            episodeNumber = episode.episode,
            videoId = episode.id,
        )
        if (download != null) {
            switchToDownloadedEpisode(download, episode)
            finishAfterHandOff()
            return@launch
        }
        PlayerStreamsRepository.loadEpisodeStreams(
            type = contentType ?: parentMetaType,
            videoId = episode.id,
            season = episode.season,
            episode = episode.episode,
        )
        val state = withNetworkBudget(EPISODE_AUTO_WAIT_MS) {
            PlayerStreamsRepository.episodeStreamsState.first { s ->
                s.blockedMessage != null || s.emptyStateReason != null ||
                    (s.groups.isNotEmpty() && !s.isAnyLoading && s.groups.none { it.isLoading })
            }
        }
        if (state == null) {
            fail("Não foi possível carregar as fontes deste episódio.")
            return@launch
        }
        state.blockedMessage?.let {
            // Ad cancelled or refused (or not authorized): nothing is released and no manual list is offered.
            fail(it)
            return@launch
        }
        val streams = state.groups.flatMap { group -> group.streams }
        if (streams.isEmpty()) {
            fail("Nenhuma fonte disponível para este episódio.")
            return@launch
        }
        val pick = ObaflixPlaybackPicker.pick(streams)
        if (pick != null) {
            switchToEpisodeStream(pick, episode)
            finishAfterHandOff()
        } else {
            // Authorized, sources exist, none is safe to start alone: the user may choose by hand.
            episodeSwitch = null
            EpisodeSwitchResume.clear()
            episodeStreamsPanelState = EpisodeStreamsPanelState(showStreams = true, selectedEpisode = episode)
            showEpisodesPanel = true
        }
    }
}
