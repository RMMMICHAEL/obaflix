package com.obaflix.ads
import org.junit.Assert.*
import org.junit.Test

class AdSafetyPolicyTest {
    @Test fun `Play cannot enable automatic interstitial or app open`() {
        for (format in listOf(AdFormat.INTERSTITIAL, AdFormat.APP_OPEN))
            assertFalse(AdSafetyPolicy.allows(true, format, true, true, true, false, true))
        assertTrue(AdSafetyPolicy.allows(false, AdFormat.INTERSTITIAL, true, true, true, false, false))
    }
    @Test fun `rewarded requires opt in and all formats respect consent entitlement fullscreen`() {
        assertFalse(AdSafetyPolicy.allows(true, AdFormat.REWARDED, true, true, true, false, false))
        for (format in AdFormat.values()) {
            assertFalse(AdSafetyPolicy.allows(false, format, true, false, true, false, true))
            assertFalse(AdSafetyPolicy.allows(false, format, true, true, false, false, true))
            assertFalse(AdSafetyPolicy.allows(false, format, true, true, true, true, true))
        }
    }
    @Test fun `bounded jittered retries and malicious caps`() {
        assertEquals(AdFailure.LOAD, AdSafetyPolicy.loadFailure(510))
        assertEquals(AdFailure.NO_INVENTORY, AdSafetyPolicy.loadFailure(1035))
        assertEquals(750L, AdSafetyPolicy.retryDelay(0, 0.0))
        assertEquals(10000L, AdSafetyPolicy.retryDelay(3, 1.0))
        assertNull(AdSafetyPolicy.retryDelay(4, 0.5))
        var now = 0L
        val cap = AdSessionCap { now }
        assertTrue(cap.available(9999, -1))
        cap.recordShow()
        assertFalse(cap.available(9999, -1))
        now = 60_000
        assertTrue(cap.available(9999, -1))
        repeat(7) { cap.recordShow(); now += 60_000 }
        assertFalse(cap.available(9999, -1))
    }
    @Test fun `remote config cannot enable interstitial on Play or lower interval`() {
        val config = RemoteAdSettings.parse("""{"interstitial":true,"rewarded":true,"sessionCap":999,"intervalSeconds":-1}""", true)
        assertFalse(config.interstitial)
        assertEquals(4, config.sessionCap)
        assertEquals(120_000, config.intervalMs)
        assertEquals(RemoteAdSettings(), RemoteAdSettings.parse("invalid", false))
    }
}
