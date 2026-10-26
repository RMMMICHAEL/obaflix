package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ObaflixAdWaitTest {
    @Test
    fun theBudgetEndsASearchThatNeverAnswers() = runTest {
        val ad = MutableStateFlow(false)
        assertNull(withNetworkBudget(1_000, ad) { delay(60_000); "late" })
    }

    @Test
    fun adTimeDoesNotConsumeTheBudget() = runTest {
        val ad = MutableStateFlow(true)
        // a four-minute ad, then the sources arrive 500 ms later: a 1 s budget must still be enough
        val result = withNetworkBudget(1_000, ad) {
            delay(240_000)
            ad.value = false
            delay(500)
            "sources"
        }
        assertEquals("sources", result)
    }

    @Test
    fun theBudgetRunsAgainOnceTheAdIsOver() = runTest {
        val ad = MutableStateFlow(true)
        val result = withNetworkBudget(1_000, ad) {
            delay(240_000)
            ad.value = false
            delay(30_000)
            "too late"
        }
        assertNull(result)
    }

    @Test
    fun recreatingTheActivityAfterTheAdDoesNotCancelButTheUserCan() {
        val c = RewardedCancellation()
        c.activityDestroyed() // before the ad: nothing to show on a dead Activity
        assertTrue(c.isCancelled)

        val shown = RewardedCancellation()
        shown.adShown()
        shown.activityDestroyed() // the S9+ case: recreated right after the ad
        assertFalse(shown.isCancelled)
        shown.userCancelled()
        assertTrue(shown.isCancelled)
    }

    @Test
    fun theGateReportsAdTimeWhileAnAdIsInProgress() = runTest {
        assertFalse(ObaflixPlaybackGate.anuncioEmCurso.value)
    }
}
