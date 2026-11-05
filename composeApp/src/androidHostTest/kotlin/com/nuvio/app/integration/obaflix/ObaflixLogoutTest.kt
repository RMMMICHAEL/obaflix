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
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ObaflixLogoutTest {
    private val original = ObaflixSession.http
    private val originalKey = AuthStorage.secretKey
    private val softwareKey = javax.crypto.KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    @BeforeTest
    fun setUp() {
        val context = RuntimeEnvironment.getApplication()
        AuthStorage.initialize(context)
        AuthStorage.secretKey = { softwareKey } // no Android Keystore under Robolectric
        ProfileStorage.initialize(context)
        WatchProgressStorage.initialize(context)
        LibraryStorage.initialize(context)
        WatchedStorage.initialize(context)
        PlatformLocalAccountDataCleaner.initialize(context)
        ObaflixSession.current = null
        ObaflixSession.http = { _, url, _, _ ->
            when {
                url.endsWith("/api/auth/csrf") -> RawHttpResponse(200, "OK", url, """{"csrfToken":"t"}""", mapOf("set-cookie" to "__Host-next-auth.csrf-token=t"))
                url.endsWith("/api/auth/callback/credentials") -> RawHttpResponse(200, "OK", url, "{}", mapOf("set-cookie" to "__Secure-next-auth.session-token=jwt"))
                else -> RawHttpResponse(200, "OK", url, """{"user":{"id":"u1","email":"a@b.c"}}""", emptyMap())
            }
        }
    }

    @AfterTest
    fun tearDown() {
        ObaflixSession.http = original
        AuthStorage.secretKey = originalKey
        ObaflixSession.current = null
    }

    @Test
    fun explicitLogoutEndsTheSessionButKeepsLocalDataForTheSameAccount() = runTest {
        assertTrue(AuthRepository.signInWithEmail("a@b.c", "pw").isSuccess)
        assertIs<AuthState.Authenticated>(AuthRepository.state.value)
        LibraryStorage.savePayload(1, "minha-lista")
        WatchedStorage.savePayload(1, "assistidos")
        WatchProgressStorage.savePayload(1, "progresso")

        assertTrue(AuthRepository.signOut().isSuccess)
        assertEquals(AuthState.Unauthenticated, AuthRepository.state.value)
        assertNull(ObaflixSession.user)
        assertNull(AuthStorage.loadObaflixSession())

        // Restart with no valid session: still signed out, never "authenticated by cache".
        AuthRepository.reinitialize()
        assertEquals(AuthState.Unauthenticated, AuthRepository.state.value)

        // Same account signs in again: everything reappears, nothing was wiped or quarantined.
        assertTrue(AuthRepository.signInWithEmail("a@b.c", "pw").isSuccess)
        assertIs<AuthState.Authenticated>(AuthRepository.state.value)
        assertEquals("minha-lista", LibraryStorage.loadPayload(1))
        assertEquals("assistidos", WatchedStorage.loadPayload(1))
        assertEquals("progresso", WatchProgressStorage.loadPayload(1))
        assertTrue(RuntimeEnvironment.getApplication().getSharedPreferences("obaflix_quarantine", 0).all.isEmpty())
    }

    @Test
    fun restartWithAStoredSessionRestoresItWithoutAnyNetworkCall() {
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
        ObaflixSession.persist()
        ObaflixSession.http = { _, _, _, _ -> error("no network on startup") }
        AuthRepository.reinitialize()
        assertIs<AuthState.Authenticated>(AuthRepository.state.value)
    }
}
