package com.nuvio.app.features.player

import com.nuvio.app.features.details.MetaVideo
import kotlin.test.Test
import kotlin.test.assertEquals

class PlayerEpisodeSwitchTest {
    private fun ep(season: Int?, episode: Int?, title: String) = MetaVideo(id = "x", title = title, season = season, episode = episode)

    @Test
    fun theLoadingScreenNamesTheChosenEpisode() {
        assertEquals("T2 · E3 — A Queda", episodeSwitchLabel(ep(2, 3, "A Queda")))
        assertEquals("T1 · E1", episodeSwitchLabel(ep(1, 1, "")))
        assertEquals("A Queda", episodeSwitchLabel(ep(null, null, "A Queda")))
    }

    @Test
    fun statusFollowsThePhaseAndTheAd() {
        assertEquals("Preparando episódio", episodeSwitchStatus(EpisodeSwitchPhase.PREPARING, adActive = false))
        assertEquals("Preparando reprodução…", episodeSwitchStatus(EpisodeSwitchPhase.PREPARING, adActive = true))
        assertEquals("Carregando player…", episodeSwitchStatus(EpisodeSwitchPhase.STARTING, adActive = true))
    }
}

class EpisodeSwitchResumeTest {
    private val ep3 = MetaVideo(id = "s:1:3", title = "Tres", season = 1, episode = 3)
    private val ep4 = MetaVideo(id = "s:1:4", title = "Quatro", season = 1, episode = 4)

    @org.junit.After
    fun reset() = EpisodeSwitchResume.clear()

    @Test
    fun anActivityRecreatedDuringTheAdFindsTheChosenEpisode() {
        EpisodeSwitchResume.begin("obaflix:serie:1", ep3) // old runtime, ad on screen
        // recreation: a new runtime asks for the same title
        assertEquals(ep3, EpisodeSwitchResume.pendingFor("obaflix:serie:1"))
        // same again during the S2S confirmation and the loading: still the same single pending episode
        assertEquals(ep3, EpisodeSwitchResume.pendingFor("obaflix:serie:1"))
    }

    @Test
    fun anotherTitleNeverResumesAndAnEndedSwitchNeverDoes() {
        EpisodeSwitchResume.begin("obaflix:serie:1", ep3)
        assertEquals(null, EpisodeSwitchResume.pendingFor("obaflix:serie:2"))
        EpisodeSwitchResume.clear() // started, failed, cancelled or manual list
        assertEquals(null, EpisodeSwitchResume.pendingFor("obaflix:serie:1"))
    }

    @Test
    fun aNewerChoiceReplacesTheOldOneInsteadOfDuplicating() {
        EpisodeSwitchResume.begin("obaflix:serie:1", ep3)
        EpisodeSwitchResume.begin("obaflix:serie:1", ep4)
        assertEquals(ep4, EpisodeSwitchResume.pendingFor("obaflix:serie:1"))
    }
}
