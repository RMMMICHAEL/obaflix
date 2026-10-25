package com.nuvio.app.integration.obaflix

import com.nuvio.app.core.auth.AuthRepository
import com.nuvio.app.features.watched.WatchedItem
import com.nuvio.app.features.watching.sync.LocalOnlyWatchedSyncAdapter
import com.nuvio.app.features.watchprogress.WatchProgressEntry
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ObaflixLocalOnlyTest {
    @AfterTest
    fun tearDown() {
        ObaflixSession.current = null
        ObaflixProgressSyncAdapter.remoteSyncEnabled = false
    }

    @Test
    fun progressDoesNotCallTheBackendByDefault() = runTest {
        ObaflixSession.current = ObaflixStoredSession(mapOf("next-auth.session-token" to "jwt"), "u1", "a@b.c")
        var calls = 0
        ObaflixProgressSyncAdapter.post = { calls++; 200 }
        val entry = WatchProgressEntry(
            contentType = "movie", parentMetaId = "obaflix:filme:1", parentMetaType = "movie", videoId = "obaflix:filme:1",
            title = "t", lastPositionMs = 90_000, durationMs = 1_440_000, lastUpdatedEpochMs = 0,
        )
        ObaflixProgressSyncAdapter.push(1, listOf(entry))
        ObaflixProgressSyncAdapter.delete(1, listOf(entry))
        assertEquals(0, calls)
        assertTrue(ObaflixProgressSyncAdapter.pull(1).isEmpty())
    }

    @Test
    fun watchedSyncIsLocalAndNeverFails() = runTest {
        val item = WatchedItem(id = "obaflix:filme:1", type = "movie", name = "t", markedAtEpochMs = 1L)
        LocalOnlyWatchedSyncAdapter.push(2, listOf(item))
        LocalOnlyWatchedSyncAdapter.delete(2, listOf(item))
        assertTrue(LocalOnlyWatchedSyncAdapter.pull(2, 100).isEmpty())
    }

    @Test
    fun unprovenOwnershipIsNeverKeptForAnotherAccount() {
        fun decide(marker: String?, cache: String?, hasData: Boolean = true) =
            AuthRepository.ownershipDecision(marker, cache, "u1", hasData)
        assertEquals(AuthRepository.DataOwnership.Keep, decide("u1", "u1"))
        assertEquals(AuthRepository.DataOwnership.Keep, decide(null, "u1")) // upgrade from a build without the marker
        assertEquals(AuthRepository.DataOwnership.Keep, decide("u1", null))
        assertEquals(AuthRepository.DataOwnership.Wipe, decide("u2", "u2")) // proven other account
        assertEquals(AuthRepository.DataOwnership.Wipe, decide(null, "u2"))
        // unknown, blank or contradictory owners with data present: back up first
        assertEquals(AuthRepository.DataOwnership.QuarantineThenWipe, decide(null, null))
        assertEquals(AuthRepository.DataOwnership.QuarantineThenWipe, decide("", "  "))
        assertEquals(AuthRepository.DataOwnership.QuarantineThenWipe, decide("u1", "u2"))
        assertEquals(AuthRepository.DataOwnership.Keep, decide(null, null, hasData = false)) // fresh install
    }
}
