package com.nuvio.app.core.auth

import android.app.Application
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ObaflixSessionEncryptionTest {
    private val secret = """{"cookies":{"__Secure-next-auth.session-token":"jwt-super-secret"},"userId":"u1","email":"a@b.c"}"""
    private val originalKey = AuthStorage.secretKey
    private val softwareKey: SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val prefs get() = RuntimeEnvironment.getApplication().getSharedPreferences("nuvio_auth", 0)

    @BeforeTest
    fun setUp() {
        AuthStorage.initialize(RuntimeEnvironment.getApplication())
        prefs.edit().clear().commit()
        AuthStorage.secretKey = { softwareKey } // Robolectric has no Android Keystore
    }

    @AfterTest
    fun tearDown() {
        AuthStorage.secretKey = originalKey
        prefs.edit().clear().commit()
    }

    private fun storedText() = prefs.all.values.joinToString("|")

    @Test
    fun sessionIsEncryptedAtRestAndSurvivesRestart() {
        AuthStorage.saveObaflixSession(secret)
        assertFalse(storedText().contains("jwt-super-secret"))
        assertEquals(secret, AuthStorage.loadObaflixSession())

        AuthStorage.initialize(RuntimeEnvironment.getApplication()) // process restart
        assertEquals(secret, AuthStorage.loadObaflixSession())

        val first = prefs.getString("obaflix_session_enc", null)
        AuthStorage.saveObaflixSession(secret)
        assertNotEquals(first, prefs.getString("obaflix_session_enc", null)) // fresh IV per write
    }

    @Test
    fun legacyPlaintextSessionIsMigratedAndErased() {
        prefs.edit().putString("obaflix_session", secret).commit()
        assertEquals(secret, AuthStorage.loadObaflixSession())
        assertNull(prefs.getString("obaflix_session", null))
        assertFalse(storedText().contains("jwt-super-secret"))
        assertEquals(secret, AuthStorage.loadObaflixSession()) // now served from the encrypted slot
    }

    @Test
    fun tamperedOrCorruptSessionAsksForNewLoginAndKeepsOtherData() {
        AuthStorage.saveDataOwner("u1")
        AuthStorage.saveObaflixSession(secret)
        val good = prefs.getString("obaflix_session_enc", null)!!
        val (iv, data) = good.split('.', limit = 2)
        val flipped = (if (data.first() == 'A') 'B' else 'A') + data.drop(1)
        prefs.edit().putString("obaflix_session_enc", "$iv.$flipped").commit()
        assertNull(AuthStorage.loadObaflixSession())
        assertNull(prefs.getString("obaflix_session_enc", null))
        assertEquals("u1", AuthStorage.loadDataOwner()) // ownership marker untouched

        prefs.edit().putString("obaflix_session_enc", "garbage").commit()
        assertNull(AuthStorage.loadObaflixSession())
    }

    @Test
    fun unavailableKeyNeverStoresPlaintextAndNeverCrashes() {
        AuthStorage.secretKey = { error("keystore unavailable") }
        AuthStorage.saveObaflixSession(secret) // session stays in memory only
        assertFalse(storedText().contains("jwt-super-secret"))
        assertNull(AuthStorage.loadObaflixSession())

        prefs.edit().putString("obaflix_session", secret).commit() // legacy, but no key to migrate with
        assertNull(AuthStorage.loadObaflixSession())
        assertFalse(storedText().contains("jwt-super-secret")) // plaintext erased: sign in again
    }

    @Test
    fun keyLostAfterSavingAsksForNewLogin() {
        AuthStorage.saveObaflixSession(secret)
        AuthStorage.secretKey = { KeyGenerator.getInstance("AES").apply { init(256) }.generateKey() } // different key
        assertNull(AuthStorage.loadObaflixSession())
    }

    @Test
    fun logoutClearsEverySessionSlot() {
        prefs.edit().putString("obaflix_session", secret).commit()
        AuthStorage.saveObaflixSession(secret)
        AuthStorage.clearObaflixSession()
        assertNull(AuthStorage.loadObaflixSession())
        assertTrue(prefs.all.keys.none { it.startsWith("obaflix_session") })
    }
}
