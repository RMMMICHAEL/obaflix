package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.library.LibraryItem
import com.nuvio.app.features.watchprogress.WatchProgressEntry
import com.nuvio.app.features.watchprogress.continueWatchingEntries
import com.nuvio.app.features.watchprogress.toContinueWatchingItem
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class ObaflixDataImportTest {
    private val applied = mutableListOf<WatchProgressEntry>()
    private val saved = mutableListOf<LibraryItem>()
    private val alreadySaved = mutableSetOf<String>()
    private var user: String? = "u1"
    private var profile = 1
    private val answers = mutableMapOf<String, Pair<Int, String>>()

    private val watchlist = """[
      {"conteudoId":"10","conteudoTipo":"filme","filme":{"titulo":"Filme Dez","poster":"https://image.tmdb.org/p10.jpg","background":"https://image.tmdb.org/b10.jpg","ano":"2020"},"serie":null},
      {"conteudoId":"20","conteudoTipo":"anime","filme":null,"serie":{"titulo":"Anime Vinte","poster":"https://image.tmdb.org/p20.jpg"}}]"""
    private val history = """[
      {"conteudoId":"20","conteudoTipo":"anime","progressoSeg":600,"duracaoSeg":1400,"temporada":2,"numeroEp":3,"updatedAt":"2026-10-20T10:00:00.000Z","filme":null,"serie":{"titulo":"Anime Vinte","poster":"https://image.tmdb.org/p20.jpg"}},
      {"conteudoId":"10","conteudoTipo":"filme","progressoSeg":1200,"duracaoSeg":7200,"temporada":null,"numeroEp":null,"updatedAt":"2026-10-21T10:00:00.000Z","filme":{"titulo":"Filme Dez"},"serie":null}]"""
    private val resume = """[
      {"id":"30","tipo":"serie","titulo":"Serie Trinta","poster":"https://image.tmdb.org/p30.jpg","progressoSeg":300,"duracaoSeg":2400,"temporada":1,"numeroEp":1,"queued":false},
      {"id":"10","tipo":"filme","titulo":"Filme Dez","progressoSeg":1200,"duracaoSeg":7200,"temporada":null,"numeroEp":null,"queued":false}]"""

    @BeforeTest
    fun setUp() {
        answers["/api/user/watchlist"] = 200 to watchlist
        answers["/api/user/history"] = 200 to history
        answers["/api/continuar-assistindo"] = 200 to resume
        ObaflixDataImport.get = { path -> answers.getValue(path) }
        ObaflixDataImport.applyProgress = { applied += it }
        ObaflixDataImport.isSaved = { id, _ -> id in alreadySaved }
        ObaflixDataImport.save = { saved += it }
        ObaflixDataImport.needsArtworkRepair = { false }
        ObaflixDataImport.activeProfile = { profile }
        ObaflixDataImport.currentUser = { user }
        ObaflixDataImport.now = { 1_000_000_000_000L }
    }

    @AfterTest
    fun tearDown() = ObaflixDataImport.reset()

    @Test
    fun listAndProgressAreMappedToTheNativeIdsAndNothingIsDeleted() = runTest {
        val outcome = ObaflixDataImport.run("u1")
        assertTrue(outcome.complete)
        assertEquals(listOf("obaflix:serie:20", "obaflix:filme:10"), saved.map { it.id }) // oldest first: server order kept
        assertEquals(listOf("series", "movie"), saved.map { it.type })
        val byVideo = applied.associateBy { it.videoId }
        assertEquals(setOf("obaflix:serie:20:2:3", "obaflix:filme:10", "obaflix:serie:30:1:1"), byVideo.keys) // no duplicate for title 10
        val episode = assertNotNull(byVideo["obaflix:serie:20:2:3"])
        assertEquals(600_000L, episode.lastPositionMs)
        assertEquals(1_400_000L, episode.durationMs)
        assertEquals("obaflix:serie:20", episode.parentMetaId)
        assertEquals(2, episode.seasonNumber)
        assertEquals(3, episode.episodeNumber)
        // "continue" rows have no timestamp: they sit below the oldest real one
        assertTrue(byVideo.getValue("obaflix:serie:30:1:1").lastUpdatedEpochMs < byVideo.getValue("obaflix:serie:20:2:3").lastUpdatedEpochMs)
    }

    @Test
    fun importedProgressIsWhatTheHomeRowShows() = runTest {
        ObaflixDataImport.run("u1")
        // The Home "Continuar assistindo" row is built by this very projection from the stored entries.
        val row = applied.continueWatchingEntries()
        assertEquals(setOf("obaflix:serie:20:2:3", "obaflix:filme:10", "obaflix:serie:30:1:1"), row.map { it.videoId }.toSet())
        val item = row.first { it.videoId == "obaflix:serie:20:2:3" }.toContinueWatchingItem()
        assertEquals("Anime Vinte", item.title)
        assertEquals("obaflix:serie:20", item.parentMetaId)
        assertEquals("series", item.parentMetaType)
    }

    @Test
    fun relativeTmdbPathsBecomeRealImageUrlsLikeTheCatalog() {
        val row = Json.parseToJsonElement(
            """{"conteudoId":"7","conteudoTipo":"serie","serie":{"titulo":"S","poster":"/p7.jpg","background":"/b7.jpg","logo":"/l7.png"}}""",
        ).jsonObject
        val item = ObaflixDataImport.parseLibraryItem(row)!!
        assertEquals("https://image.tmdb.org/t/p/w500/p7.jpg", item.poster)
        assertEquals("https://image.tmdb.org/t/p/w1280/b7.jpg", item.banner)
        val entry = ObaflixDataImport.parseProgress(
            Json.parseToJsonElement("""{"conteudoId":"7","conteudoTipo":"serie","progressoSeg":5,"duracaoSeg":60,"temporada":1,"numeroEp":2,"updatedAt":"2026-10-20T10:00:00.000Z","serie":{"titulo":"S","poster":"/p7.jpg","background":"/b7.jpg"}}""").jsonObject,
            fallbackUpdatedAt = null,
        )!!
        assertEquals("https://image.tmdb.org/t/p/w500/p7.jpg", entry.poster)
        assertEquals("https://image.tmdb.org/t/p/w1280/b7.jpg", entry.background)
    }

    @Test
    fun anItemSavedWithBrokenArtworkIsSavedAgainOnlyForTheRepair() = runTest {
        alreadySaved += listOf("obaflix:filme:10", "obaflix:serie:20")
        ObaflixDataImport.needsArtworkRepair = { it.id == "obaflix:filme:10" }
        ObaflixDataImport.run("u1")
        assertEquals(listOf("obaflix:filme:10"), saved.map { it.id })
    }

    @Test
    fun runningTwiceChangesNothingTheSecondTime() = runTest {
        ObaflixDataImport.run("u1")
        alreadySaved += saved.map { it.id }
        saved.clear()
        ObaflixDataImport.run("u1")
        assertTrue(saved.isEmpty()) // already in "Minha Lista": skipped, never duplicated
    }

    @Test
    fun aFailedOrCappedAnswerIsNeverCountedAsComplete() = runTest {
        answers["/api/user/history"] = 500 to "erro"
        val failed = ObaflixDataImport.run("u1")
        assertFalse(failed.complete)
        assertEquals(2, failed.librarySaved) // what did arrive is still kept

        val capped = (1..20).joinToString(",") {
            """{"conteudoId":"$it","conteudoTipo":"filme","progressoSeg":10,"duracaoSeg":100,"updatedAt":"2026-10-20T10:00:00.000Z","filme":{"titulo":"T$it"},"serie":null}"""
        }
        answers["/api/user/history"] = 200 to "[$capped]"
        assertFalse(ObaflixDataImport.run("u1").complete) // 20 = the endpoint's cap: may be partial

        answers["/api/user/history"] = 200 to history
        ObaflixDataImport.get = { path -> if (path.contains("watchlist")) throw RuntimeException("sem rede") else answers.getValue(path) }
        assertFalse(ObaflixDataImport.run("u1").complete) // connection failure during the import
    }

    @Test
    fun invalidContentIsSkippedAndKeepsTheRunIncomplete() = runTest {
        answers["/api/continuar-assistindo"] = 200 to """[{"id":"../x","tipo":"filme","titulo":"Ruim","progressoSeg":1,"duracaoSeg":2}]"""
        val outcome = ObaflixDataImport.run("u1")
        assertEquals(1, outcome.skippedInvalid)
        assertFalse(outcome.complete)
        assertEquals(2, applied.size) // the valid history rows were still applied
    }

    @Test
    fun anotherAccountOrProfileMidRunWritesNothing() = runTest {
        ObaflixDataImport.get = { path -> user = "u2"; answers.getValue(path) } // account switch while requests are in flight
        val outcome = ObaflixDataImport.run("u1")
        assertFalse(outcome.complete)
        assertTrue(saved.isEmpty() && applied.isEmpty())

        user = "u1"
        ObaflixDataImport.get = { path -> profile = 2; answers.getValue(path) }
        ObaflixDataImport.run("u1")
        assertTrue(saved.isEmpty() && applied.isEmpty())
    }
}
