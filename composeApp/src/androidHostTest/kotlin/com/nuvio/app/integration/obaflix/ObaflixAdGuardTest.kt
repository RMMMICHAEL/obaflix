package com.nuvio.app.integration.obaflix

import android.app.Application
import com.nuvio.app.integration.obaflix.ads.AdHost
import com.nuvio.app.integration.obaflix.ads.LevelPlayInterstitialAdProvider
import com.nuvio.app.integration.obaflix.ads.ObaflixAds
import com.nuvio.app.integration.obaflix.ads.ObaflixLevelPlay
import com.nuvio.app.integration.obaflix.ads.AdShowOutcome
import com.nuvio.app.integration.obaflix.ads.UnityInterstitialAdProvider
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import com.unity3d.ads.UnityAds
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ObaflixAdGuardTest {
    @Test
    fun ineligibleProviderNeverTouchesTheSdk() {
        val provider = UnityInterstitialAdProvider(RuntimeEnvironment.getApplication(), elegivel = { false })
        provider.initialize()
        provider.preload()
        assertFalse(provider.pronto)

        val outcomes = mutableListOf<AdShowOutcome>()
        var opened = false
        provider.show(object : AdHost { override val disponivel = true }, { opened = true }) { outcomes += it }
        assertEquals(listOf(AdShowOutcome.NAO_EXIBIDO), outcomes) // terminal callback exactly once
        assertFalse(opened)
    }

    @Test
    fun levelPlayNeverStartsWithoutConfirmedEligibility() {
        ObaflixAdEligibility.reset()
        ObaflixLevelPlay.start(RuntimeEnvironment.getApplication())
        assertFalse(ObaflixLevelPlay.initRequested)
        ObaflixAdEligibility.confirm(false)
        ObaflixLevelPlay.start(RuntimeEnvironment.getApplication())
        assertFalse(ObaflixLevelPlay.initRequested)
        ObaflixAdEligibility.reset()
    }

    @Test
    fun completedSkippedAndMissingStateStayDistinct() {
        val r = UnityInterstitialAdProvider.Companion::resultadoDe
        assertEquals(AdShowOutcome.COMPLETED, r(UnityAds.UnityAdsShowCompletionState.COMPLETED))
        assertEquals(AdShowOutcome.SKIPPED, r(UnityAds.UnityAdsShowCompletionState.SKIPPED))
        assertEquals(AdShowOutcome.SKIPPED, r(null)) // never counted as watched
    }

    @Test
    fun failedContextualSignalKeepsTheSdkOff() {
        var asked = 0
        val provider = UnityInterstitialAdProvider(
            RuntimeEnvironment.getApplication(), elegivel = { true }, contextual = { asked++; false },
        )
        provider.initialize()
        assertEquals(1, asked)
        assertFalse(provider.pronto)
    }

    @Test
    fun ineligibleLevelPlayInterstitialNeverTouchesTheSdkAndEndsOnce() {
        val provider = LevelPlayInterstitialAdProvider(
            RuntimeEnvironment.getApplication(), elegivel = { false }, sdkPronto = { true },
        )
        provider.initialize()
        provider.preload()
        assertFalse(provider.pronto)
        assertFalse(ObaflixLevelPlay.initRequested)

        val outcomes = mutableListOf<AdShowOutcome>()
        provider.show(object : AdHost { override val disponivel = true }, {}) { outcomes += it }
        assertEquals(listOf(AdShowOutcome.NAO_EXIBIDO), outcomes)
    }

    @Test
    fun interstitialStaysOnTheDirectSdkUntilLevelPlayIsValidated() {
        ObaflixAds.substituirProvedorParaTeste(null)
        assertEquals(false, com.nuvio.app.integration.obaflix.ads.ObaflixAdsConfig.INTERSTITIAL_VIA_LEVELPLAY)
        assertEquals(
            UnityInterstitialAdProvider::class,
            ObaflixAds.provider(RuntimeEnvironment.getApplication())::class,
        )
        ObaflixAds.substituirProvedorParaTeste(null)
    }

    @Test
    fun withTheRewardedOnTheInterstitialUsesTheSameInitializerAsLevelPlay() {
        val app = RuntimeEnvironment.getApplication()
        try {
            com.nuvio.app.integration.obaflix.ObaflixConfig.usarPreview("https://x-y.vercel.app")
            ObaflixAds.substituirProvedorParaTeste(null)
            assertEquals(LevelPlayInterstitialAdProvider::class, ObaflixAds.provider(app)::class)
        } finally {
            com.nuvio.app.integration.obaflix.ObaflixConfig.restaurarProducao()
            ObaflixAds.substituirProvedorParaTeste(null)
        }
        // no Preview pinned: the direct provider, exactly as before
        assertEquals(UnityInterstitialAdProvider::class, ObaflixAds.provider(app)::class)
        ObaflixAds.substituirProvedorParaTeste(null)
    }
}
