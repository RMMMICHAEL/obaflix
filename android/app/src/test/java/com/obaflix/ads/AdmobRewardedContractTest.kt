package com.obaflix.ads

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** SDK runtime/device behavior requires separate instrumentation homologation. */
class AdmobRewardedContractTest {
    private val root = File("src/main/java/com/obaflix/ads")
    @Test fun `each distribution uses its own Standard unit and requires opt in`() {
        val source = File(root, "AdmobRewarded.java").readText()
        assertTrue(source.contains("BuildConfig.PLAY_STORE_BUILD ? BuildConfig.ADMOB_REWARDED_PLAY_STANDARD_ID : BuildConfig.ADMOB_REWARDED_DIRECT_STANDARD_ID"))
        assertTrue(source.contains("!BuildConfig.ADMOB_REWARDED_APPROVED || !optIn || !eligible || !consent"))
        assertTrue(source.contains("sdk_unavailable"))
        assertTrue(source.contains("no_inventory"))
    }
    @Test fun `server eligibility precedes CMP and Google SDK initialization`() {
        val bridge = File(root, "AdsBridge.kt").readText().substringAfter("fun mostrarRewardedOpcional")
        assertTrue(bridge.indexOf("AdmobChallengeEligibility.check") < bridge.indexOf("AdConsent.request"))
        val source = File(root, "GoogleAdsInitialization.java").readText()
        assertTrue(source.indexOf("!eligible || !consent") < source.indexOf("MobileAds.initialize"))
        assertFalse(source.contains("disableMediationAdapterInitialization()"))
    }
    @Test fun `SSV options precede show and client reward never enters legacy completion`() {
        val source = File(root, "AdmobRewarded.java").readText()
        assertTrue(source.indexOf("setServerSideVerificationOptions") < source.indexOf("ad.show("))
        assertTrue(source.contains("new ServerSideVerificationOptions(nonce, nonce)"))
        assertFalse(source.contains("concessao"))
        val bridge = File(root, "AdsBridge.kt").readText().substringAfter("fun mostrarRewardedOpcional").substringBefore("fun mostrarBanner")
        assertFalse(bridge.contains("__obaflixAnuncioConcluido"))
    }
}
