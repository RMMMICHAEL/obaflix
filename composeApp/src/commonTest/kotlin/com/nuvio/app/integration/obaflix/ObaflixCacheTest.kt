package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ObaflixCacheTest {
    private val path = "/api/filmes/66627589"
    private val sheet = """{"imdbId":"tt37287335"}"""
    private val stored = mutableMapOf<String, String>()
    private var age: Long? = 1_000L
    private var fetches = 0
    private var failing = false

    private val originalFetch = ObaflixCatalogAddon.fetch

    @BeforeTest
    fun setUp() {
        ObaflixCatalogAddon.clearCache()
        ObaflixCatalogAddon.fetch = { fetches++; if (failing) error("offline") else sheet }
        ObaflixCatalogAddon.disk = object : ObaflixDiskCache {
            override fun read(key: String) = stored[key]
            override fun write(key: String, value: String) { stored[key] = value }
            override fun ageMs(key: String) = age
        }
    }

    @AfterTest
    fun tearDown() {
        ObaflixCatalogAddon.fetch = originalFetch
        ObaflixCatalogAddon.disk = null
        ObaflixCatalogAddon.clearCache()
    }

    @Test
    fun recentSheetOnDiskNeedsNoRequestAfterColdStart() = runTest {
        stored[ObaflixCatalogAddon.diskKey(path)] = sheet
        assertEquals("tt37287335", ObaflixCatalogAddon.addonVideoId("obaflix:filme:66627589"))
        assertEquals(0, fetches)
    }

    @Test
    fun oldSheetOnDiskIsRefreshedAndSaved() = runTest {
        stored[ObaflixCatalogAddon.diskKey(path)] = """{"imdbId":"tt1"}"""
        age = 3 * 60 * 60 * 1000L
        assertEquals("tt37287335", ObaflixCatalogAddon.addonVideoId("obaflix:filme:66627589"))
        assertEquals(1, fetches)
        assertEquals(sheet, stored[ObaflixCatalogAddon.diskKey(path)])
    }

    @Test
    fun offlineKeepsServingTheLastValidSheetWithoutRetryStorm() = runTest {
        stored[ObaflixCatalogAddon.diskKey(path)] = sheet
        age = 3 * 60 * 60 * 1000L
        failing = true
        repeat(3) { assertEquals("tt37287335", ObaflixCatalogAddon.addonVideoId("obaflix:filme:66627589")) }
        assertEquals(1, fetches) // later calls fall in the 1-minute backoff
    }

    @Test
    fun failureWithoutAnyCopyStillFails() = runTest {
        failing = true
        assertFailsWith<IllegalStateException> { ObaflixCatalogAddon.addonVideoId("obaflix:filme:1") }
    }

    @Test
    fun searchAndPersonalDataNeverGoToDisk() = runTest {
        ObaflixCatalogAddon.fetch = { """{"filmes":[],"series":[]}""" }
        runCatching { ObaflixCatalogAddon.respond(ObaflixConfig.CATALOG_ADDON_MANIFEST_URL.removeSuffix("manifest.json") + "catalog/movie/obaflix-search/search=abc.json") }
        assertTrue(stored.keys.none { it.contains("/api/search") || '#' in it })
        assertNull(stored["/api/recommendations#u1"])
    }
}
