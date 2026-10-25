package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.addons.RawHttpResponse
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ObaflixLoginTest {
    private data class Call(val method: String, val url: String, val headers: Map<String, String>, val body: String)

    private val calls = mutableListOf<Call>()
    private val original = ObaflixSession.http

    @AfterTest
    fun tearDown() {
        ObaflixSession.http = original
        ObaflixSession.current = null
    }

    private fun backend(sessionCookie: Boolean, sessionBody: String) {
        ObaflixSession.http = { method, url, headers, body ->
            calls += Call(method, url, headers, body)
            when {
                url.endsWith("/api/auth/csrf") -> RawHttpResponse(
                    200, "OK", url, """{"csrfToken":"tok"}""",
                    mapOf("set-cookie" to "__Host-next-auth.csrf-token=tok%7Chash; Path=/; HttpOnly; Secure; SameSite=Lax"),
                )
                url.endsWith("/api/auth/callback/credentials") -> RawHttpResponse(
                    200, "OK", url, """{"url":"https://obaflixbr.com"}""",
                    if (sessionCookie) {
                        mapOf("set-cookie" to "__Secure-next-auth.session-token=jwt; Path=/; Expires=Wed, 21 Oct 2026 10:00:00 GMT; HttpOnly; Secure")
                    } else {
                        emptyMap()
                    },
                )
                url.endsWith("/api/auth/session") -> RawHttpResponse(200, "OK", url, sessionBody, emptyMap())
                else -> error("unexpected $url")
            }
        }
    }

    @Test
    fun originIsTheBackendsCanonicalDomain() {
        assertEquals("https://obaflixbr.com", ObaflixConfig.BASE_URL)
        assertTrue(ObaflixConfig.CATALOG_ADDON_MANIFEST_URL.startsWith("https://obaflixbr.com/"))
    }

    @Test
    fun successfulLoginKeepsOnlySessionCookieAndTalksOnlyToOrigin() = runTest {
        backend(sessionCookie = true, sessionBody = """{"user":{"id":"u1","email":"a@b.c"}}""")

        assertNull(ObaflixSession.signIn("  A@B.c ", "s3nh@ & =x"))

        assertEquals(listOf("GET", "POST", "GET"), calls.map { it.method })
        assertTrue(calls.all { it.url.startsWith("https://obaflixbr.com/") })
        assertTrue(calls.all { it.headers["Origin"] == "https://obaflixbr.com" })
        val post = calls[1]
        assertTrue("__Host-next-auth.csrf-token=tok%7Chash" in post.headers["Cookie"].orEmpty())
        assertEquals("csrfToken=tok&email=A%40B.c&senha=s3nh%40%20%26%20%3Dx&json=true", post.body)
        assertTrue("__Secure-next-auth.session-token=jwt" in calls[2].headers["Cookie"].orEmpty())
        assertEquals(mapOf("__Secure-next-auth.session-token" to "jwt"), ObaflixSession.user?.cookies)
        assertEquals("u1", ObaflixSession.user?.userId)
    }

    @Test
    fun wrongPasswordIsReportedInPortugueseAndStoresNothing() = runTest {
        backend(sessionCookie = false, sessionBody = "{}")
        assertEquals("E-mail ou senha inválidos.", ObaflixSession.signIn("a@b.c", "x"))
        assertNull(ObaflixSession.user)
    }

    @Test
    fun dnsSinkholeIsToldApartFromOtherFailures() = runTest {
        class ConnectException(message: String) : Exception(message)
        class UnknownHostException(message: String) : Exception(message)
        class SSLHandshakeException(message: String) : Exception(message)
        class SocketTimeoutException(message: String) : Exception(message)

        val blocked = "A rede ou o DNS do aparelho está bloqueando o Obaflix."
        ObaflixSession.http = { _, _, _, _ -> throw ConnectException("Failed to connect to obaflixbr.com/0.0.0.0:443") }
        assertTrue(ObaflixSession.signIn("a@b.c", "x")!!.startsWith(blocked))
        assertTrue(connectionFailureMessage(UnknownHostException("Unable to resolve host")).startsWith(blocked))
        assertTrue(connectionFailureMessage(SSLHandshakeException("cert")).startsWith("Não foi possível estabelecer uma conexão segura"))
        assertEquals("O Obaflix demorou para responder. Tente novamente.", connectionFailureMessage(SocketTimeoutException("x")))
        assertEquals(
            "Não foi possível conectar ao Obaflix. Verifique sua conexão.",
            connectionFailureMessage(ConnectException("Failed to connect to obaflixbr.com/216.198.79.1:443")),
        )
        assertNull(ObaflixSession.user)
    }
}
