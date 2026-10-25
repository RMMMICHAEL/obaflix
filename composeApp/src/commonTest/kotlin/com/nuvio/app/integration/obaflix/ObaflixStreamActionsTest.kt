package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.streams.StreamBehaviorHints
import com.nuvio.app.features.streams.StreamItem
import com.nuvio.app.features.streams.StreamProxyHeaders
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ObaflixStreamActionsTest {
    private val authorizeBodies = mutableListOf<String>()
    private var answer = 200 to """{"decisao":"PERMITIDO"}"""
    private val handed = mutableListOf<ObaflixCastRequest>()

    private val hlsStream = StreamItem(
        url = "https://cdn.example/master.m3u8?t=1",
        addonName = "FenixFlix",
        addonId = "fenix",
        behaviorHints = StreamBehaviorHints(
            proxyHeaders = StreamProxyHeaders(
                request = mapOf("Referer" to "https://embed.example/", "User-Agent" to "UA/1", "Cookie" to "secret"),
            ),
        ),
    )

    @BeforeTest
    fun setUp() {
        ObaflixPlaybackGate.clear()
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
        ObaflixPlaybackGate.post = { _, body -> authorizeBodies += body; answer }
        ObaflixCast.handoff = { request -> handed += request; ObaflixCastResult.OPENED }
    }

    @AfterTest
    fun tearDown() {
        ObaflixSession.current = null
        ObaflixCast.handoff = null
        ObaflixCast.verificarApp = null
    }

    @Test
    fun castRequestKeepsOnlyHttpsMediaAndPlaybackHeaders() {
        val request = ObaflixCast.requestFor(hlsStream, "Título", "https://img.example/p.jpg")!!
        assertTrue(request.isHls)
        assertEquals(mapOf("Referer" to "https://embed.example/", "User-Agent" to "UA/1"), request.headers) // no cookies
        assertNull(ObaflixCast.requestFor(hlsStream.copy(url = "http://cdn.example/a.mp4"), "T", null))
        assertNull(ObaflixCast.requestFor(hlsStream, "T", "http://img.example/p.jpg")?.poster)
    }

    @Test
    fun castIsAuthorizedPerActionWithItsOwnPurpose() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val cast = obaflixCastGate("obaflix:filme:5", "Título", null, scope)
        cast(hlsStream)
        cast(hlsStream)
        scope.advanceUntilIdle()
        assertEquals(2, handed.size)
        assertEquals(2, authorizeBodies.size) // a new authorization for every hand-off
        assertTrue(authorizeBodies.all { Json.parseToJsonElement(it).jsonObject["finalidade"]!!.jsonPrimitive.content == "transmissao" })

        answer = 200 to """{"decisao":"NEGADO"}"""
        cast(hlsStream)
        scope.advanceUntilIdle()
        assertEquals(2, handed.size) // refused: nothing leaves the app
    }

    @Test
    fun aMissingCastAppIsReportedBeforeAnyAuthorizationOrAd() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        ObaflixCast.verificarApp = { ObaflixCastResult.STORE_OPENED } // the store/browser was already opened
        obaflixCastGate("obaflix:filme:5", "Título", null, scope)(hlsStream)
        scope.advanceUntilIdle()
        assertTrue(authorizeBodies.isEmpty(), "no authorization, so no ad, for an action that cannot happen")
        assertTrue(handed.isEmpty())

        ObaflixCast.verificarApp = { ObaflixCastResult.UNAVAILABLE }
        obaflixCastGate("obaflix:filme:5", "Título", null, scope)(hlsStream)
        scope.advanceUntilIdle()
        assertTrue(authorizeBodies.isEmpty())

        ObaflixCast.verificarApp = { ObaflixCastResult.OPENED } // installed: the normal flow runs
        obaflixCastGate("obaflix:filme:5", "Título", null, scope)(hlsStream)
        scope.advanceUntilIdle()
        assertEquals(1, authorizeBodies.size)
        assertEquals(1, handed.size)
    }

    @Test
    fun aSourceThatCannotBeCastAsksForNoAd() = runTest {
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        obaflixCastGate("obaflix:filme:5", "Título", null, scope)(hlsStream.copy(url = "http://cdn.example/a.mp4"))
        scope.advanceUntilIdle()
        assertTrue(authorizeBodies.isEmpty())
        assertTrue(handed.isEmpty())
    }

    @Test
    fun detailsActionIsConsumedOnce() {
        ObaflixStreamAction.request(ObaflixStreamAction.CAST)
        assertEquals(ObaflixStreamAction.CAST, ObaflixStreamAction.consume())
        assertNull(ObaflixStreamAction.consume()) // next "Assistir" plays normally
    }
}
