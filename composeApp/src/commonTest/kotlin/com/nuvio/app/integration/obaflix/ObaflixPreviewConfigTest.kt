package com.nuvio.app.integration.obaflix

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ObaflixPreviewConfigTest {
    @AfterTest
    fun tearDown() = ObaflixConfig.restaurarProducao()

    @Test
    fun productionIsTheDefaultAndPreviewIsOffUnlessPinned() {
        assertEquals("https://obaflix.vercel.app", ObaflixConfig.BASE_URL)
        assertFalse(ObaflixConfig.usandoPreview)
        assertEquals("https://obaflix.vercel.app/api/nuvio-addon/manifest.json", ObaflixConfig.CATALOG_ADDON_MANIFEST_URL)
    }

    @Test
    fun aVercelPreviewOriginIsPinnedForTheWholeApp() {
        assertTrue(ObaflixConfig.usarPreview("https://obaflix-git-feat-levelplay-s2s-michaeltrader.vercel.app/"))
        assertTrue(ObaflixConfig.usandoPreview)
        assertEquals("https://obaflix-git-feat-levelplay-s2s-michaeltrader.vercel.app", ObaflixConfig.BASE_URL)
        assertEquals(
            "https://obaflix-git-feat-levelplay-s2s-michaeltrader.vercel.app/api/nuvio-addon/manifest.json",
            ObaflixConfig.CATALOG_ADDON_MANIFEST_URL,
        )
        assertEquals("https://obaflix-git-feat-levelplay-s2s-michaeltrader.vercel.app/termos", ObaflixConfig.TERMS_URL)
    }

    @Test
    fun productionHttpOtherDomainsPathsAndTricksAreRefusedAndNeverChangeTheOrigin() {
        for (url in listOf(
            "https://obaflix.vercel.app", "https://obaflixbr.com", "https://www.obaflixbr.com", "https://obaflix.online", "http://x.vercel.app",
            "https://example.com", "https://x.vercel.app/api", "https://x.vercel.app:8443", "https://user@x.vercel.app",
            "https://x.vercel.app?a=b", "https://.vercel.app", "https://X.vercel.app", "https://obaflix.online.vercel.app", "", "  ",
        )) {
            assertFalse(ObaflixConfig.usarPreview(url), url)
            assertFalse(ObaflixConfig.usandoPreview, url)
            assertEquals("https://obaflix.vercel.app", ObaflixConfig.BASE_URL, url)
        }
    }
}
