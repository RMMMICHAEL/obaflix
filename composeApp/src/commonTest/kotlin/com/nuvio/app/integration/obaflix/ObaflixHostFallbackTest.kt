package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class UnknownHostException : Exception("Unable to resolve host")
class SSLHandshakeException : Exception("tls")

class ObaflixHostFallbackTest {
    private val vercel = "https://obaflix.vercel.app"
    private val br = "https://obaflixbr.com"
    private val online = "https://obaflix.online"
    private var now = 1_000L

    @BeforeTest
    fun setUp() {
        ObaflixConfig.restaurarProducao()
        ObaflixHostFallback.clock = { now }
        ObaflixHostFallback.attemptTimeoutMs = 1_000L
    }

    @AfterTest
    fun tearDown() {
        ObaflixConfig.restaurarProducao()
        ObaflixHostFallback.attemptTimeoutMs = 10_000L
    }

    private fun json(host: String) = """{"host":"$host"}"""

    @Test
    fun theMainHostAnswersWithOneRequestAndNothingSwitches() = runTest {
        val calls = mutableListOf<String>()
        val body = ObaflixHostFallback.get("/api/x") { url -> calls += url; json("ok") }
        assertEquals(listOf("$vercel/api/x"), calls)
        assertEquals(json("ok"), body)
        assertEquals(vercel, ObaflixConfig.CATALOG_BASE_URL)
    }

    @Test
    fun aBlockedMainHostFallsBackAndTheWorkingHostIsRemembered() = runTest {
        val calls = mutableListOf<String>()
        val fetch: suspend (String) -> String = { url ->
            calls += url
            if (url.startsWith(vercel)) throw UnknownHostException() else json("alt")
        }
        ObaflixHostFallback.get("/api/x", fetch)
        assertEquals(listOf("$vercel/api/x", "$br/api/x"), calls)
        assertEquals(br, ObaflixConfig.CATALOG_BASE_URL)
        calls.clear()
        ObaflixHostFallback.get("/api/y", fetch) // remembered: no new probing of the blocked host
        assertEquals(listOf("$br/api/y"), calls)
    }

    @Test
    fun anOperatorBlockPageAndTlsErrorsCountAsHostFailures() = runTest {
        val body = ObaflixHostFallback.get("/api/x") { url ->
            when {
                url.startsWith(vercel) -> "<html>blocked by operator</html>" // 200 with HTML is not a working API
                url.startsWith(br) -> throw SSLHandshakeException()
                else -> json("online")
            }
        }
        assertEquals(json("online"), body)
        assertEquals(online, ObaflixConfig.CATALOG_BASE_URL)
    }

    @Test
    fun anHttpErrorOrAnEmptyResultIsTheServerSpeakingAndNeverSwitchesHost() = runTest {
        val calls = mutableListOf<String>()
        assertFailsWith<IllegalStateException> {
            ObaflixHostFallback.get("/api/x") { url -> calls += url; throw IllegalStateException("HTTP 401") }
        }
        assertEquals(1, calls.size)
        assertEquals(vercel, ObaflixConfig.CATALOG_BASE_URL)
        assertEquals("[]", ObaflixHostFallback.get("/api/x") { "[]" }) // empty list is a valid answer
    }

    @Test
    fun aSlowHostTimesOutAndTheNextOneAnswers() = runTest {
        val body = ObaflixHostFallback.get("/api/x") { url ->
            if (url.startsWith(vercel)) { delay(60_000); json("late") } else json("fast")
        }
        assertEquals(json("fast"), body)
        assertEquals(br, ObaflixConfig.CATALOG_BASE_URL)
    }

    @Test
    fun allHostsDownOrNoInternetFailsAfterOneRoundAndKeepsTheOriginalHost() = runTest {
        val calls = mutableListOf<String>()
        assertFailsWith<UnknownHostException> {
            ObaflixHostFallback.get("/api/x") { url -> calls += url; throw UnknownHostException() }
        }
        assertEquals(3, calls.size) // one round, no retry loop
        assertEquals(vercel, ObaflixConfig.CATALOG_BASE_URL)
    }

    @Test
    fun thePreferredHostIsTriedAgainAfterTheRetryWindow() = runTest {
        val down: suspend (String) -> String = { url -> if (url.startsWith(vercel)) throw UnknownHostException() else json("alt") }
        ObaflixHostFallback.get("/api/x", down)
        assertEquals(br, ObaflixConfig.CATALOG_BASE_URL)
        now += ObaflixConfig.PRIMARY_RETRY_MS + 1
        val calls = mutableListOf<String>()
        ObaflixHostFallback.get("/api/x") { url -> calls += url; json("back") } // the main host is back
        assertEquals(listOf("$vercel/api/x"), calls)
        assertEquals(vercel, ObaflixConfig.CATALOG_BASE_URL)
    }

    @Test
    fun sessionAndRightsCallsStayOnTheCanonicalHostAndThePreviewKeepsPersonalRowsHidden() {
        ObaflixConfig.rememberCatalogOrigin(online, now)
        assertEquals(vercel, ObaflixConfig.BASE_URL) // authenticated origin never moves with the catalog
        assertTrue(!ObaflixConfig.usarPreview(vercel)) // the production host can never be pinned as a "Preview"
        assertTrue(!ObaflixConfig.usarPreview(br))
        assertTrue(!ObaflixConfig.catalogoSeparado)
        assertTrue(ObaflixConfig.usarPreview("https://x-y.vercel.app"))
        assertTrue(ObaflixConfig.catalogoSeparado)
    }
}
