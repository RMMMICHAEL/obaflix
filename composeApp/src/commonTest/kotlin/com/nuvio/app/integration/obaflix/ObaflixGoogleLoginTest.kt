package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.addons.RawHttpResponse
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ObaflixGoogleLoginTest {
    private val pkce = ObaflixGoogleLogin.Pkce(
        verifier = "v".repeat(43), challenge = "c".repeat(43), state = "s".repeat(43),
    )
    private val ticket = "abcDEF0123456789_-.abcDEF0123456789_-.xyz"
    private var opened: String? = null

    @BeforeTest
    fun setUp() {
        ObaflixGoogleLogin.reset()
        ObaflixGoogleLogin.newPkce = { pkce }
        ObaflixGoogleLogin.openBrowser = { opened = it; true }
    }

    @AfterTest
    fun tearDown() {
        ObaflixGoogleLogin.reset()
        ObaflixGoogleLogin.newPkce = null
        ObaflixGoogleLogin.openBrowser = null
        ObaflixSession.current = null
        ObaflixConfig.restaurarProducao()
    }

    @Test
    fun theLoginPageIsOpenedOnTheMainHostWithPkceAndState() {
        assertTrue(ObaflixGoogleLogin.start())
        val url = assertNotNull(opened)
        assertTrue(url.startsWith("https://obaflix.vercel.app/desktop-auth?"), url) // never obaflixbr.com
        assertTrue("challenge=${pkce.challenge}" in url && "state=${pkce.state}" in url && "callbackUrl=%2Fdesktop" in url)
        assertFalse("verifier" in url) // the verifier never leaves the device until the exchange
    }

    @Test
    fun onlyTheAnswerToThePendingRequestIsAcceptedOnce() {
        ObaflixGoogleLogin.start()
        assertNull(ObaflixGoogleLogin.consume("obaflix://auth/callback?ticket=$ticket&state=${"x".repeat(43)}")) // wrong state
        assertNull(ObaflixGoogleLogin.consume("obaflix://auth/callback?ticket=bad&state=${pkce.state}")) // malformed ticket
        assertNull(ObaflixGoogleLogin.consume("nuvio://auth/trakt?ticket=$ticket&state=${pkce.state}")) // another link
        val ok = ObaflixGoogleLogin.consume("obaflix://auth/callback?ticket=$ticket&state=${pkce.state}")
        assertEquals(ticket to pkce.verifier, ok)
        assertNull(ObaflixGoogleLogin.consume("obaflix://auth/callback?ticket=$ticket&state=${pkce.state}")) // replay
    }

    @Test
    fun withoutAPendingRequestOrABrowserNothingHappens() {
        assertNull(ObaflixGoogleLogin.consume("obaflix://auth/callback?ticket=$ticket&state=${pkce.state}"))
        ObaflixGoogleLogin.openBrowser = { false }
        assertFalse(ObaflixGoogleLogin.start())
        assertNull(ObaflixGoogleLogin.consume("obaflix://auth/callback?ticket=$ticket&state=${pkce.state}")) // failed start leaves nothing
    }

    @Test
    fun theTicketIsTradedOnTheMainHostAndTheSessionComesFromThatHost() = runTest {
        val calls = mutableListOf<Triple<String, String, String>>()
        ObaflixSession.http = { method, url, headers, body ->
            calls += Triple(method, url, body)
            when {
                url.endsWith("/api/desktop-auth/exchange") -> RawHttpResponse(
                    200, "OK", url, "<body>OK</body>",
                    mapOf("set-cookie" to "__Secure-next-auth.session-token=JWT123; Path=/; HttpOnly; Secure"),
                )
                url.endsWith("/api/auth/session") -> RawHttpResponse(200, "OK", url, """{"user":{"id":"u1","email":"a@b.c"}}""", emptyMap())
                else -> RawHttpResponse(404, "NF", url, "", emptyMap())
            }
        }
        assertNull(ObaflixSession.signInWithTicket(ticket, pkce.verifier))
        assertTrue(calls.all { it.second.startsWith("https://obaflix.vercel.app/") })
        assertEquals("ticket=$ticket&verifier=${pkce.verifier}", calls.first().third)
        assertEquals("u1", ObaflixSession.user?.userId)
    }

    @Test
    fun aRejectedTicketCreatesNoSession() = runTest {
        ObaflixSession.http = { _, url, _, _ -> RawHttpResponse(401, "Unauthorized", url, "handoff_invalido", emptyMap()) }
        val reason = ObaflixSession.signInWithTicket(ticket, pkce.verifier)
        assertNotNull(reason)
        assertNull(ObaflixSession.user)
    }
}
