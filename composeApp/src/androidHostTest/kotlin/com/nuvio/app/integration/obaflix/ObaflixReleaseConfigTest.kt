package com.nuvio.app.integration.obaflix

import android.content.pm.ApplicationInfo
import com.nuvio.app.integration.obaflix.ads.ObaflixAdsConfig
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ObaflixReleaseConfigTest {
    @Test
    fun unityTestAdsOnlyOnDebuggableBuilds() {
        assertTrue(ObaflixAdsConfig.isTestMode(ApplicationInfo.FLAG_DEBUGGABLE or ApplicationInfo.FLAG_HAS_CODE))
        assertFalse(ObaflixAdsConfig.isTestMode(ApplicationInfo.FLAG_HAS_CODE)) // release: real ads
    }

    @Test
    fun levelPlayStaysOffInReleaseUntilApproved() {
        assertTrue(ObaflixAdsConfig.levelPlayAllowed(ApplicationInfo.FLAG_DEBUGGABLE))
        assertFalse(ObaflixAdsConfig.levelPlayAllowed(ApplicationInfo.FLAG_HAS_CODE))
        assertFalse(ObaflixAdsConfig.REWARDED_ENABLED)
        assertFalse(ObaflixAdsConfig.REWARDED_PLAYER_ENABLED) // commercial Rewarded still off
        assertFalse(ObaflixAdsConfig.BANNER_ENABLED) // banners permanently off
    }
}

class ObaflixRewardedGatingConfigTest {
    private val debug = android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE
    private val release = android.content.pm.ApplicationInfo.FLAG_HAS_CODE

    @Test
    fun rewardedPlayerRunsOnlyInADebugBuildPinnedToAPreview() {
        assertTrue(ObaflixAdsConfig.rewardedPlayerEnabled(debug, previewPinned = true))
        assertFalse(ObaflixAdsConfig.rewardedPlayerEnabled(debug, previewPinned = false), "debug against production: off")
        assertFalse(ObaflixAdsConfig.rewardedPlayerEnabled(release, previewPinned = true), "release: off even if a Preview were pinned")
        assertFalse(ObaflixAdsConfig.rewardedPlayerEnabled(release, previewPinned = false))
        assertFalse(ObaflixAdsConfig.REWARDED_PLAYER_ENABLED, "the release switch stays off")
    }

    @Test
    fun theReleaseOptInIsTheOnlyWayToEnableTheRewardedInARelease() {
        assertFalse(ObaflixAdsConfig.rewardedPlayerEnabled(release, previewPinned = false)) // default release: off
        assertFalse(ObaflixAdsConfig.rewardedPlayerEnabled(release, previewPinned = true))  // a Preview never enables a release
        assertTrue(ObaflixAdsConfig.rewardedPlayerEnabled(release, previewPinned = false, releaseOptIn = true))
        assertFalse(ObaflixAdsConfig.REWARDED_PLAYER_ENABLED, "the compiled-in switch stays off")
        assertFalse(ObaflixAdsConfig.BANNER_ENABLED, "banners stay off in every build")
    }

    @Test
    fun theManifestOptInIsReadWhetherAaptTypedItAsBooleanOrString() {
        // Regression: a "true" placeholder is compiled as a Boolean; Bundle.getString returned null and the opt-in was lost.
        with(ObaflixAdsConfig) {
            assertTrue(true.isOptInValue())
            assertTrue("true".isOptInValue())
            assertFalse(false.isOptInValue())
            assertFalse("false".isOptInValue())
            assertFalse("".isOptInValue())
            assertFalse(null.isOptInValue())
            assertFalse("TRUE".isOptInValue())
        }
    }
}
