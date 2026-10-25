package com.nuvio.app.features.addons

import com.nuvio.app.integration.obaflix.ObaflixConfig
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OfficialAddonsTest {
    @Test
    fun theOwnersPreinstalledAddonsAreOfficialAndUserAddonsAreNot() {
        assertTrue(AddonRepository.isOfficialAddon(ObaflixConfig.CATALOG_ADDON_MANIFEST_URL))
        ObaflixConfig.DEFAULT_PLAYBACK_ADDON_URLS.forEach { assertTrue(AddonRepository.isOfficialAddon(it)) }
        assertFalse(AddonRepository.isOfficialAddon("https://addon.externo.example/manifest.json"))
        // same host with another path, or a look-alike, is not official
        assertFalse(AddonRepository.isOfficialAddon("https://fenixflix.fenixhub.online/outro/manifest.json"))
    }
}
