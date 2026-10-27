package com.nuvio.app.integration.obaflix

import android.app.Application
import com.nuvio.app.core.auth.AuthRepository
import com.nuvio.app.core.auth.AuthState
import com.nuvio.app.core.auth.AuthStorage
import com.nuvio.app.core.storage.PlatformLocalAccountDataCleaner
import com.nuvio.app.features.addons.RawHttpResponse
import com.nuvio.app.features.library.LibraryStorage
import com.nuvio.app.features.profiles.ProfileStorage
import com.nuvio.app.features.watched.WatchedStorage
import com.nuvio.app.features.watchprogress.WatchProgressStorage
import kotlinx.coroutines.test.runTest
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ObaflixAccountSwitchSafetyTest {
    @Test
    fun quarantineFailureAbortsTheLoginBeforeAnyDestructiveCleanup() = runTest {
        val context = RuntimeEnvironment.getApplication()
        AuthStorage.initialize(context)
        ProfileStorage.initialize(context)
        WatchProgressStorage.initialize(context)
        LibraryStorage.initialize(context)
        WatchedStorage.initialize(context)
        PlatformLocalAccountDataCleaner.initialize(context)

        // Unowned data on the device (no marker, no profile cache) and a full quarantine.
        LibraryStorage.savePayload(2, "minha-lista")
        WatchedStorage.savePayload(2, "assistidos")
        val max = PlatformLocalAccountDataCleaner.MAX_QUARANTINE_SNAPSHOTS
        val quarantine = context.getSharedPreferences("obaflix_quarantine", 0)
        repeat(max) { i -> quarantine.edit().putString("${i + 1}|nuvio_library|library_payload_1", "antigo$i").commit() }
        val before = quarantine.all.toMap()

        val original = ObaflixSession.http
        ObaflixSession.http = { _, url, _, _ ->
            when {
                url.endsWith("/api/auth/csrf") -> RawHttpResponse(200, "OK", url, """{"csrfToken":"t"}""", mapOf("set-cookie" to "__Host-next-auth.csrf-token=t"))
                url.endsWith("/api/auth/callback/credentials") -> RawHttpResponse(200, "OK", url, "{}", mapOf("set-cookie" to "__Secure-next-auth.session-token=jwt"))
                else -> RawHttpResponse(200, "OK", url, """{"user":{"id":"u9","email":"x@y.z"}}""", emptyMap())
            }
        }
        try {
            val result = AuthRepository.signInWithEmail("x@y.z", "pw")
            assertTrue(result.isFailure)
            assertEquals("minha-lista", LibraryStorage.loadPayload(2)) // nothing wiped
            assertEquals("assistidos", WatchedStorage.loadPayload(2))
            assertEquals(before, quarantine.all.toMap()) // every backup preserved
            assertNull(ObaflixSession.user) // no session: the new account sees nothing
            assertNull(AuthStorage.loadObaflixSession())
            assertTrue(AuthRepository.state.value !is AuthState.Authenticated)
        } finally {
            ObaflixSession.http = original
            ObaflixSession.current = null
        }
    }
}
