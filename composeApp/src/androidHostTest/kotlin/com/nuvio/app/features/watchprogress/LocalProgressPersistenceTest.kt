package com.nuvio.app.features.watchprogress

import android.app.Application
import com.nuvio.app.core.storage.PlatformLocalAccountDataCleaner
import com.nuvio.app.features.library.LibraryStorage
import com.nuvio.app.features.watched.WatchedStorage
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class LocalProgressPersistenceTest {
    private fun init() {
        val context = RuntimeEnvironment.getApplication()
        WatchProgressStorage.initialize(context)
        LibraryStorage.initialize(context)
        WatchedStorage.initialize(context)
        PlatformLocalAccountDataCleaner.initialize(context)
    }

    @Test
    fun progressLibraryAndWatchedAreSeparatedPerProfileAndSurviveRestart() {
        init()
        WatchProgressStorage.savePayload(1, "p-1"); WatchProgressStorage.savePayload(2, "p-2")
        LibraryStorage.savePayload(1, "l-1"); LibraryStorage.savePayload(2, "l-2")
        WatchedStorage.savePayload(1, "w-1"); WatchedStorage.savePayload(2, "w-2")

        init() // re-initializing mimics a process restart: data is re-read from disk
        assertEquals("p-1", WatchProgressStorage.loadPayload(1)); assertEquals("p-2", WatchProgressStorage.loadPayload(2))
        assertEquals("l-1", LibraryStorage.loadPayload(1)); assertEquals("l-2", LibraryStorage.loadPayload(2))
        assertEquals("w-1", WatchedStorage.loadPayload(1)); assertEquals("w-2", WatchedStorage.loadPayload(2))
        assertNull(LibraryStorage.loadPayload(3)); assertNull(WatchedStorage.loadPayload(3)); assertNull(WatchProgressStorage.loadPayload(3))
    }

    @Test
    fun quarantineKeepsUnownedDataRecoverableBeforeTheWipe() {
        init()
        assertFalse(PlatformLocalAccountDataCleaner.hasUserData())
        LibraryStorage.savePayload(2, "minha-lista")
        WatchedStorage.savePayload(2, "assistidos")
        assertTrue(PlatformLocalAccountDataCleaner.hasUserData())

        PlatformLocalAccountDataCleaner.quarantine()
        PlatformLocalAccountDataCleaner.wipe()

        assertNull(LibraryStorage.loadPayload(2)) // no longer visible to the app
        val saved = RuntimeEnvironment.getApplication().getSharedPreferences("obaflix_quarantine", 0).all
        assertTrue(saved.values.contains("minha-lista") && saved.values.contains("assistidos"))
    }

    @Test
    fun quarantineNeverDropsACopyAndRefusesPastTheLimit() {
        init()
        val prefs = RuntimeEnvironment.getApplication().getSharedPreferences("obaflix_quarantine", 0)
        val max = PlatformLocalAccountDataCleaner.MAX_QUARANTINE_SNAPSHOTS
        LibraryStorage.savePayload(1, "v0")
        PlatformLocalAccountDataCleaner.quarantine()
        PlatformLocalAccountDataCleaner.quarantine() // same data: no second copy
        assertEquals(1, prefs.all.keys.map { it.substringBefore('|') }.distinct().size)

        for (i in 1 until max) {
            LibraryStorage.savePayload(1, "v$i")
            Thread.sleep(2) // snapshots are stamped by time
            PlatformLocalAccountDataCleaner.quarantine()
        }
        val before = prefs.all.toMap()
        assertEquals(max, before.keys.map { it.substringBefore('|') }.distinct().size)

        LibraryStorage.savePayload(1, "novo")
        assertFailsWith<IllegalStateException> { PlatformLocalAccountDataCleaner.quarantine() }
        assertEquals(before, prefs.all.toMap()) // every existing copy preserved
        assertEquals("novo", LibraryStorage.loadPayload(1)) // and the live data untouched
    }
}
