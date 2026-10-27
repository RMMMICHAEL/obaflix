package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.details.MetaVideo
import com.nuvio.app.features.streams.StreamBehaviorHints
import com.nuvio.app.features.streams.StreamItem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ObaflixPlayerAutoTest {
    private fun ep(season: Int?, episode: Int?) = MetaVideo(id = "s:$season:$episode", title = "E", season = season, episode = episode)
    private val videos = listOf(ep(2, 1), ep(1, 2), ep(0, 1), ep(1, 1), ep(2, 2))

    @Test
    fun previousEpisodeFollowsSeasonAndEpisodeOrderAcrossSeasons() {
        assertEquals("s:1:1", ObaflixEpisodeNav.previous(videos, 1, 2)?.id)
        assertEquals("s:1:2", ObaflixEpisodeNav.previous(videos, 2, 1)?.id) // last of the previous season
        assertEquals("s:2:1", ObaflixEpisodeNav.previous(videos, 2, 2)?.id)
    }

    @Test
    fun theFirstEpisodeSpecialsAndUnknownPositionsHaveNoPrevious() {
        assertNull(ObaflixEpisodeNav.previous(videos, 1, 1)) // specials (season 0) are not "before" episode 1
        assertNull(ObaflixEpisodeNav.previous(videos, null, null)) // a movie
        assertNull(ObaflixEpisodeNav.previous(videos, 9, 9))
    }

    private fun src(url: String?, name: String = "Fonte", notWebReady: Boolean = false) = StreamItem(
        url = url, name = name, addonName = "a", addonId = "a", behaviorHints = StreamBehaviorHints(notWebReady = notWebReady),
    )

    @Test
    fun theBestPlayableSourceIsPickedWithoutAskingTheUser() {
        val http = src("http://fenix.example/v.mp4", "4K")
        val https720 = src("https://cdn.example/a.mp4", "720p")
        val https1080 = src("https://cdn.example/b.mp4", "1080p")
        assertEquals(https1080, ObaflixPlaybackPicker.pick(listOf(http, https720, https1080), ownServer = { false }))
        assertEquals(http, ObaflixPlaybackPicker.pick(listOf(http), ownServer = { false })) // playback may use http (cast may not)
    }

    @Test
    fun ownServersComeFirstAndNonPlayableSourcesAreNeverPicked() {
        val own = src(null, "Obaflix")
        val https = src("https://cdn.example/a.mp4")
        assertEquals(own, ObaflixPlaybackPicker.pick(listOf(https, own), ownServer = { it === own }))
        assertNull(ObaflixPlaybackPicker.pick(listOf(src(null), src("magnet:?xt=urn:btih:x"), src("https://x/y.mp4", notWebReady = true)), ownServer = { false }))
    }
}
