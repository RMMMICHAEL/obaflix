package com.nuvio.app.integration.obaflix

import kotlin.test.Test
import kotlin.test.assertEquals

class ObaflixAdProviderChoiceTest {
    private val default = ObaflixAdProviderChoice.DEFAULT

    @Test
    fun defaultIsUnityAndLevelPlay() {
        assertEquals(false, default.interstitialAdmob)
        assertEquals(false, default.rewardedAdmob)
    }

    @Test
    fun onlyTheExactAdmobAnswerSelectsAdmob() {
        val both = ObaflixAdProviderChoice.parse("""{"interstitial":"admob","rewarded":"admob"}""")
        assertEquals(ObaflixAdProviderChoice.Choice(interstitialAdmob = true, rewardedAdmob = true), both)
        val onlyInterstitial = ObaflixAdProviderChoice.parse("""{"interstitial":"admob","rewarded":"levelplay"}""")
        assertEquals(ObaflixAdProviderChoice.Choice(interstitialAdmob = true, rewardedAdmob = false), onlyInterstitial)
    }

    @Test
    fun anythingElseKeepsTheDefault() {
        for (body in listOf("", "not json", "[]", "{}", """{"interstitial":"ADMOB"}""", """{"interstitial":true,"rewarded":1}""", """{"interstitial":" admob"}""")) {
            assertEquals(default, ObaflixAdProviderChoice.parse(body), body)
        }
    }

    @Test
    fun noSignedInAccountMeansDefault() {
        ObaflixAdProviderChoice.reset()
        assertEquals(default, ObaflixAdProviderChoice.choice())
    }
}
