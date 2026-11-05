package com.nuvio.app.integration.obaflix

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ObaflixSourceProbeAndroidTest {
    @Test
    fun mediaAnsweringOkOrPartialIsAccepted() {
        assertTrue(ObaflixSourceProbeAndroid.acceptable(true, true, 200, "video/mp4"))
        assertTrue(ObaflixSourceProbeAndroid.acceptable(true, true, 206, "video/mp4; charset=binary"))
        assertTrue(ObaflixSourceProbeAndroid.acceptable(false, false, 200, "application/vnd.apple.mpegurl"))
        assertTrue(ObaflixSourceProbeAndroid.acceptable(true, true, 200, "application/octet-stream"))
    }

    @Test
    fun anHtmlPageAnErrorOrAMissingTypeIsNotMedia() {
        assertFalse(ObaflixSourceProbeAndroid.acceptable(true, true, 200, "text/html"))
        assertFalse(ObaflixSourceProbeAndroid.acceptable(true, true, 200, "application/json"))
        assertFalse(ObaflixSourceProbeAndroid.acceptable(true, true, 200, null))
        assertFalse(ObaflixSourceProbeAndroid.acceptable(true, true, 403, "video/mp4"))
        assertFalse(ObaflixSourceProbeAndroid.acceptable(true, true, 404, "video/mp4"))
    }

    @Test
    fun aRedirectFromHttpsToHttpIsADowngradeAndIsRefused() {
        assertFalse(ObaflixSourceProbeAndroid.acceptable(true, false, 200, "video/mp4"))
        assertTrue(ObaflixSourceProbeAndroid.acceptable(false, true, 200, "video/mp4")) // upgrading is fine
    }
}
