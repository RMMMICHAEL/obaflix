package com.nuvio.app.integration.obaflix

import android.app.Application
import android.content.Context
import com.nuvio.app.core.storage.PlatformLocalAccountDataCleaner
import kotlinx.coroutines.runBlocking
import nuvio.composeapp.generated.resources.Res
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ObaflixProfilesTest {
    @Test
    fun defaultProfileNameComesFromTheEmail() {
        assertEquals("Maria", ObaflixProfiles.defaultProfileName("maria.silva@exemplo.com"))
        assertEquals("Joao", ObaflixProfiles.defaultProfileName("123.joao@exemplo.com"))
        assertEquals("Perfil", ObaflixProfiles.defaultProfileName(null))
        assertEquals("Perfil", ObaflixProfiles.defaultProfileName("12345@exemplo.com"))
    }

    @Test
    fun localAvatarsArePackagedPngs() = runBlocking {
        val avatars = ObaflixProfiles.localAvatars
        assertEquals(12, avatars.map { it.id }.toSet().size)
        assertTrue(avatars.any { it.id == ObaflixProfiles.DEFAULT_AVATAR_ID })
        avatars.forEach { avatar ->
            val n = avatar.id.removePrefix("obaflix-")
            val bytes = Res.readBytes("files/avatars/obaflix_avatar_$n.png")
            // PNG signature: the file is really bundled and decodable as PNG.
            assertEquals(listOf(0x89, 0x50, 0x4E, 0x47), bytes.take(4).map { it.toInt() and 0xFF })
            assertTrue(avatar.localImageUrl!!.endsWith("obaflix_avatar_$n.png"))
        }
        assertTrue(Res.readBytes("files/avatars/LICENSE-AVATARS.txt").decodeToString().contains("CC0"))
    }

    @Test
    fun logoutKeepsProfilesButStillWipesAccountData() {
        val context = RuntimeEnvironment.getApplication()
        val profiles = context.getSharedPreferences("nuvio_profile_cache", Context.MODE_PRIVATE)
        val addons = context.getSharedPreferences("nuvio_addons", Context.MODE_PRIVATE)
        profiles.edit().putString("payload", "{\"userId\":\"u1\"}").commit()
        addons.edit().putString("x", "y").commit()
        PlatformLocalAccountDataCleaner.initialize(context)
        PlatformLocalAccountDataCleaner.wipe()
        assertEquals("{\"userId\":\"u1\"}", profiles.getString("payload", null))
        assertEquals(null, addons.getString("x", null))
    }
}
