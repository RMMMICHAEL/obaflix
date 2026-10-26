package com.nuvio.app.features.player.skip

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class IntroDbEpisodeTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    @Test
    fun urlUsesOfficialEndpointAndRejectsInvalidIds() {
        assertEquals(
            "https://api.introdb.app/segments?imdb_id=tt0903747&season=1&episode=2",
            introDbEpisodeSegmentsUrl("https://api.introdb.app/", "tt0903747", 1, 2),
        )
        assertNull(introDbEpisodeSegmentsUrl("https://api.introdb.app", "obaflix", 1, 2))
        assertNull(introDbEpisodeSegmentsUrl("https://api.introdb.app", "tt0903747", 0, 2))
        assertNull(introDbEpisodeSegmentsUrl("https://api.introdb.app", "tt0903747", 1, 0))
        assertNull(introDbEpisodeSegmentsUrl("", "tt0903747", 1, 2))
    }

    @Test
    fun introComesFromMillisecondsAndMissingSegmentsAreIgnored() {
        // Shape returned by api.introdb.app (Breaking Bad S01E02).
        val body = """{"imdb_id":"tt0903747","season":1,"episode":2,
            "intro":{"start_sec":314.5,"end_sec":331,"start_ms":314500,"end_ms":331000,"confidence":1},
            "recap":null,"outro":{"start_ms":2843000,"end_ms":2901000},"post_credits":null,"no_intro":false}"""
        val intervals = json.decodeFromString<IntroDbSegmentsResponse>(body).episodeSkipIntervals()
        assertEquals(listOf(SkipInterval(314.5, 331.0, "intro", "introdb"), SkipInterval(2843.0, 2901.0, "outro", "introdb")), intervals)

        val empty = """{"imdb_id":"tt0903747","season":9,"episode":9,"intro":null,"recap":null,"outro":null}"""
        assertTrue(json.decodeFromString<IntroDbSegmentsResponse>(empty).episodeSkipIntervals().isEmpty())

        val broken = """{"intro":{"start_ms":50000,"end_ms":40000},"recap":{"start_ms":-5,"end_ms":10}}"""
        assertTrue(json.decodeFromString<IntroDbSegmentsResponse>(broken).episodeSkipIntervals().isEmpty())
    }
}
