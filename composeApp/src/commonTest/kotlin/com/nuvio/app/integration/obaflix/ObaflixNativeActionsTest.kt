package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.streams.StreamBehaviorHints
import com.nuvio.app.features.streams.StreamItem
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** "Transmitir" / "Baixar" for Obaflix titles: one tap, one ad, then the Obaflix servers; never a list, never a second ad. */
class ObaflixNativeActionsTest {
    private val authorizeBodies = mutableListOf<String>()
    private var answer = 200 to """{"decisao":"PERMITIDO"}"""
    private val handed = mutableListOf<ObaflixCastRequest>()
    private val listedFor = mutableListOf<String>()
    private val prepared = mutableListOf<String>()
    private val queued = mutableListOf<String>()

    private fun server(id: String) = StreamItem(url = null, name = "Servidor $id", addonName = "Obaflix", addonId = "obaflix", sourceName = "Obaflix")
    private fun media(id: String, url: String, type: String? = null) =
        server(id).copy(url = url, streamType = type, behaviorHints = StreamBehaviorHints())

    private var mediaBy: Map<String, StreamItem> = mapOf(
        "S1" to media("S1", "https://cdn1.example/v/master.m3u8", "hls"),
        "S2" to media("S2", "https://cdn2.example/v/a.mp4"),
        "S3" to media("S3", "https://cdn3.example/v/b.mp4"),
    )

    @BeforeTest
    fun setUp() {
        ObaflixPlaybackGate.clear()
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
        ObaflixPlaybackGate.post = { _, body -> authorizeBodies += body; answer }
        ObaflixPlaybackGate.adPresenter = null
        ObaflixCast.handoff = { request -> handed += request; ObaflixCastResult.OPENED }
        ObaflixCast.verificarApp = { ObaflixCastResult.OPENED }
        ObaflixNativeActions.serversFor = { _, purpose -> listedFor += purpose; listOf(server("S1"), server("S2"), server("S3")) }
        ObaflixNativeActions.prepare = { s ->
            prepared += s.name.orEmpty()
            mediaBy.getValue(s.name.orEmpty().removePrefix("Servidor "))
        }
    }

    @AfterTest
    fun tearDown() {
        ObaflixSession.current = null
        ObaflixCast.handoff = null
        ObaflixCast.verificarApp = null
        ObaflixSourceProbe.check = null
        ObaflixPlaybackGate.adPresenter = null
        ObaflixPlaybackGate.clear()
    }

    @Test
    fun castAsksOneAuthorizationForItsOwnPurposeAndListsOnlyObaflixServers() = runTest {
        ObaflixNativeActions.castNow("obaflix:filme:5", "Título", null)
        assertEquals(1, authorizeBodies.size)
        assertTrue(authorizeBodies.single().contains("\"transmissao\""))
        assertEquals(listOf("transmissao"), listedFor) // the server list is asked under the action's purpose
        assertEquals(listOf("https://cdn1.example/v/master.m3u8"), handed.map { it.url })
        assertTrue(handed.single().isHls)
    }

    @Test
    fun aServerThatDoesNotAnswerIsSkippedWithTheSameAuthorization() = runTest {
        ObaflixSourceProbe.check = { url, _ -> !url.contains("master.m3u8") }
        ObaflixNativeActions.castNow("obaflix:filme:5", "Título", null)
        assertEquals(1, authorizeBodies.size) // no second ad
        assertEquals(listOf("https://cdn2.example/v/a.mp4"), handed.map { it.url })
        assertEquals(listOf("Servidor S1", "Servidor S2"), prepared)
    }

    @Test
    fun aServerThatFailsToResolveFallsThroughToTheNext() = runTest {
        ObaflixNativeActions.prepare = { s ->
            prepared += s.name.orEmpty()
            if (s.name.orEmpty().endsWith("S1")) error("provider down") else mediaBy.getValue(s.name.orEmpty().removePrefix("Servidor "))
        }
        ObaflixNativeActions.castNow("obaflix:filme:5", "Título", null)
        assertEquals(listOf("https://cdn2.example/v/a.mp4"), handed.map { it.url })
        assertEquals(1, authorizeBodies.size)
    }

    @Test
    fun noServerWorkingHandsNothingOverAndNeverAsksASecondAd() = runTest {
        ObaflixSourceProbe.check = { _, _ -> false }
        ObaflixNativeActions.castNow("obaflix:filme:5", "Título", null)
        assertTrue(handed.isEmpty())
        assertEquals(1, authorizeBodies.size)
        assertEquals(3, prepared.size) // at most three servers
    }

    @Test
    fun aMissingCastAppIsHandledBeforeAnyAd() = runTest {
        ObaflixCast.verificarApp = { ObaflixCastResult.STORE_OPENED }
        ObaflixNativeActions.castNow("obaflix:filme:5", "Título", null)
        assertTrue(authorizeBodies.isEmpty())
        assertTrue(listedFor.isEmpty())
        assertTrue(handed.isEmpty())
    }

    @Test
    fun aRefusedAuthorizationOrDeclinedAdListsNothing() = runTest {
        answer = 403 to """{"error":"negado"}"""
        ObaflixNativeActions.castNow("obaflix:filme:5", "Título", null)
        assertTrue(listedFor.isEmpty())
        assertTrue(handed.isEmpty())
    }

    @Test
    fun downloadSkipsStreamsTakesTheFirstDirectFileAndAuthorizesItsOwnPurpose() = runTest {
        ObaflixNativeActions.downloadNow("obaflix:filme:5") { queued += it.url.orEmpty(); true }
        assertEquals(1, authorizeBodies.size)
        assertTrue(authorizeBodies.single().contains("\"download\""))
        assertEquals(listOf("download"), listedFor)
        assertEquals(listOf("https://cdn2.example/v/a.mp4"), queued) // S1 is HLS: not downloadable
    }

    @Test
    fun downloadFallsThroughWhenTheQueueRefusesOrTheFileDoesNotAnswer() = runTest {
        ObaflixSourceProbe.check = { url, _ -> !url.contains("cdn2") }
        ObaflixNativeActions.downloadNow("obaflix:filme:5") { queued += it.url.orEmpty(); true }
        assertEquals(listOf("https://cdn3.example/v/b.mp4"), queued)
        assertEquals(1, authorizeBodies.size)
    }

    @Test
    fun downloadWithOnlyStreamsStartsNothing() = runTest {
        mediaBy = mapOf(
            "S1" to media("S1", "https://cdn1.example/v/master.m3u8", "hls"),
            "S2" to media("S2", "https://cdn2.example/v/other.m3u8"),
            "S3" to media("S3", "https://cdn3.example/v/x.txt", "hls"),
        )
        ObaflixNativeActions.downloadNow("obaflix:filme:5") { queued += it.url.orEmpty(); true }
        assertTrue(queued.isEmpty())
    }

    @Test
    fun invalidContentIsRefusedBeforeAnything() = runTest {
        ObaflixNativeActions.castNow("tt1234567", "Título", null)
        assertTrue(authorizeBodies.isEmpty())
        assertTrue(listedFor.isEmpty())
    }
}
