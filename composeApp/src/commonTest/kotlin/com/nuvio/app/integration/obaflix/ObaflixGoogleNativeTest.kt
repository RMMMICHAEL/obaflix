package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class ObaflixGoogleNativeTest {
    private val ticket = "t".repeat(40)
    private var sent: String? = null
    private var nonceSeen: String? = null

    @BeforeTest
    fun setUp() {
        ObaflixGoogleLogin.newPkce = { ObaflixGoogleLogin.Pkce("verifier-123", "challenge-123", "state-123") }
        ObaflixGoogleLogin.nativeIdToken = { nonce -> nonceSeen = nonce; ObaflixGoogleLogin.NativeResult.Token("a.b.c") }
        ObaflixGoogleLogin.postNative = { body -> sent = body; 200 to """{"ticket":"$ticket"}""" }
    }

    @AfterTest
    fun tearDown() {
        ObaflixGoogleLogin.nativeIdToken = null
        ObaflixGoogleLogin.newPkce = null
        ObaflixGoogleLogin.postNative = { ObaflixSession.postPublic("/api/desktop-auth/google-native", it) }
        ObaflixGoogleLogin.reset()
    }

    @Test
    fun theTokenIsBoundToThePkceChallengeAndTheTicketComesBackWithTheVerifier() = runTest {
        val attempt = ObaflixGoogleLogin.signInNative()
        assertEquals("challenge-123", nonceSeen) // nonce = challenge: the token is valid for this attempt only
        assertTrue(sent!!.contains("\"idToken\":\"a.b.c\"") && sent!!.contains("\"challenge\":\"challenge-123\"") && sent!!.contains("\"state\":\"state-123\""))
        val t = assertIs<ObaflixGoogleLogin.NativeAttempt.Ticket>(attempt)
        assertEquals(ticket, t.ticket)
        assertEquals("verifier-123", t.verifier) // the verifier never leaves the device
        assertTrue(!sent!!.contains("verifier-123"))
    }

    @Test
    fun noPickerOrUnavailableFallsBackToTheBrowserAndDismissalOpensNothing() = runTest {
        ObaflixGoogleLogin.nativeIdToken = { ObaflixGoogleLogin.NativeResult.Unavailable }
        assertIs<ObaflixGoogleLogin.NativeAttempt.Fallback>(ObaflixGoogleLogin.signInNative())
        ObaflixGoogleLogin.nativeIdToken = { ObaflixGoogleLogin.NativeResult.Cancelled }
        assertIs<ObaflixGoogleLogin.NativeAttempt.Cancelled>(ObaflixGoogleLogin.signInNative())
        ObaflixGoogleLogin.nativeIdToken = null
        assertIs<ObaflixGoogleLogin.NativeAttempt.Fallback>(ObaflixGoogleLogin.signInNative())
    }

    @Test
    fun serverAnswersDecideTheOutcome() = runTest {
        ObaflixGoogleLogin.postNative = { 403 to """{"codigo":"vincular_exige_senha"}""" }
        assertIs<ObaflixGoogleLogin.NativeAttempt.Refused>(ObaflixGoogleLogin.signInNative()) // no browser detour around a refusal
        ObaflixGoogleLogin.postNative = { 401 to "{}" }
        assertIs<ObaflixGoogleLogin.NativeAttempt.Fallback>(ObaflixGoogleLogin.signInNative())
        ObaflixGoogleLogin.postNative = { 200 to """{"ticket":"curto"}""" }
        assertIs<ObaflixGoogleLogin.NativeAttempt.Fallback>(ObaflixGoogleLogin.signInNative()) // malformed ticket is never used
        ObaflixGoogleLogin.postNative = { throw IllegalStateException("offline") }
        assertIs<ObaflixGoogleLogin.NativeAttempt.Fallback>(ObaflixGoogleLogin.signInNative())
    }
}
