package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class ObaflixAdChoiceTest {
    @Test
    fun watchingIsAnExplicitChoiceAndCancelAnswersFalse() = runTest {
        val yes = async(start = CoroutineStart.UNDISPATCHED) { ObaflixAdChoice.ask() }
        assertNotNull(ObaflixAdChoice.pending.value)
        ObaflixAdChoice.pending.value!!.complete(true)
        assertEquals(true, yes.await())
        assertNull(ObaflixAdChoice.pending.value)

        val no = async(start = CoroutineStart.UNDISPATCHED) { ObaflixAdChoice.ask() }
        ObaflixAdChoice.pending.value!!.complete(false)
        assertEquals(false, no.await())
    }

    @Test
    fun aCancelledCallerRemovesTheQuestionAndNothingIsReleased() = runTest {
        val job = async(start = CoroutineStart.UNDISPATCHED) { ObaflixAdChoice.ask() }
        assertNotNull(ObaflixAdChoice.pending.value)
        job.cancel()
        job.join()
        assertNull(ObaflixAdChoice.pending.value)
    }
}
