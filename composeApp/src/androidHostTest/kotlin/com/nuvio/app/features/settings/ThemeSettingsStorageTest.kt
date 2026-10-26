package com.nuvio.app.features.settings

import android.app.Application
import android.app.LocaleManager
import android.content.Context
import com.nuvio.app.core.storage.ProfileScopedKey
import com.nuvio.app.core.sync.decodeSyncBoolean
import com.nuvio.app.core.sync.decodeSyncString
import com.nuvio.app.core.sync.encodeSyncString
import com.nuvio.app.core.ui.CustomThemeColors
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nuvio.composeapp.generated.resources.Res
import nuvio.composeapp.generated.resources.media_movie
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ThemeSettingsStorageTest {
    @BeforeTest
    fun initialize() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("nuvio_theme_settings", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("obaflix_app_language", Context.MODE_PRIVATE).edit().clear().commit()
        ThemeSettingsStorage.initialize(context)
    }

    private fun languagePreferences() =
        RuntimeEnvironment.getApplication().getSharedPreferences("obaflix_app_language", Context.MODE_PRIVATE)

    @Test
    fun glowPreferenceSurvivesReloadAndSync() {
        ThemeSettingsStorage.saveNavBarGlowEnabled(false)
        ThemeSettingsStorage.initialize(RuntimeEnvironment.getApplication())
        assertEquals(false, ThemeSettingsStorage.loadNavBarGlowEnabled())
        val payload = ThemeSettingsStorage.exportToSyncPayload()
        assertEquals(false, payload.decodeSyncBoolean("nav_bar_glow_enabled"))

        ThemeSettingsStorage.saveNavBarGlowEnabled(true)
        ThemeSettingsStorage.replaceFromSyncPayload(payload)
        assertEquals(false, ThemeSettingsStorage.loadNavBarGlowEnabled())
    }

    @Test
    fun olderPayloadClearsOnlyTheCurrentProfilesGlowPreference() {
        val preferences = RuntimeEnvironment.getApplication()
            .getSharedPreferences("nuvio_theme_settings", Context.MODE_PRIVATE)
        val otherProfileKey = ProfileScopedKey.of("nav_bar_glow_enabled", 99)
        preferences.edit().putBoolean(otherProfileKey, false).commit()
        ThemeSettingsStorage.saveNavBarGlowEnabled(false)

        ThemeSettingsStorage.replaceFromSyncPayload(buildJsonObject {})

        assertNull(ThemeSettingsStorage.loadNavBarGlowEnabled())
        assertEquals(false, preferences.getBoolean(otherProfileKey, true))
    }

    @Test
    fun savedGradientRoundTripsThroughProfileSync() {
        val colors = CustomThemeColors(0x123456, 0xABCDEF, 0x654321).encode()
        ThemeSettingsStorage.saveCustomThemeColors(colors)
        ThemeSettingsStorage.saveSelectedTheme("CUSTOM")
        val payload = ThemeSettingsStorage.exportToSyncPayload()

        assertEquals(colors, payload.decodeSyncString("custom_theme_colors"))
        assertEquals("CUSTOM", payload.decodeSyncString("selected_theme"))

        ThemeSettingsStorage.saveCustomThemeColors(CustomThemeColors.Default.encode())
        ThemeSettingsStorage.replaceFromSyncPayload(payload)

        assertEquals(colors, ThemeSettingsStorage.loadCustomThemeColors())
        assertEquals("CUSTOM", ThemeSettingsStorage.loadSelectedTheme())
    }

    @Test
    fun choosingAnotherThemeKeepsTheSavedGradient() {
        val colors = CustomThemeColors(0x112233, 0x445566, 0x778899).encode()
        ThemeSettingsStorage.saveCustomThemeColors(colors)
        ThemeSettingsStorage.saveSelectedTheme("CUSTOM")
        ThemeSettingsStorage.saveSelectedTheme("WHITE")

        assertEquals(colors, ThemeSettingsStorage.loadCustomThemeColors())
        assertEquals(colors, ThemeSettingsStorage.exportToSyncPayload().decodeSyncString("custom_theme_colors"))
    }

    @Test
    fun replacingAnOlderPayloadClearsOnlyTheCurrentProfilesGradient() {
        val context = RuntimeEnvironment.getApplication()
        val preferences = context.getSharedPreferences("nuvio_theme_settings", Context.MODE_PRIVATE)
        val otherProfileKey = ProfileScopedKey.of("custom_theme_colors", 99)
        preferences.edit().putString(otherProfileKey, "#111111,#222222,#333333").commit()
        ThemeSettingsStorage.saveCustomThemeColors(CustomThemeColors.Default.encode())

        ThemeSettingsStorage.replaceFromSyncPayload(buildJsonObject {
            put("selected_theme", encodeSyncString("WHITE"))
        })

        assertNull(ThemeSettingsStorage.loadCustomThemeColors())
        assertEquals("WHITE", ThemeSettingsStorage.loadSelectedTheme())
        assertEquals("#111111,#222222,#333333", preferences.getString(otherProfileKey, null))
    }
    @Test
    fun freshInstallationUsesBrazilianPortugueseOnAnEnglishDevice() {
        assertEquals("pt-BR", ThemeSettingsStorage.loadSelectedAppLanguage())
        assertEquals(
            "pt-BR",
            RuntimeEnvironment.getApplication().getSystemService(LocaleManager::class.java)
                .applicationLocales.toLanguageTags(),
        )
    }

    @Test
    fun oldGlobalEnglishPreferenceMigratesWithoutChangingOtherSettings() {
        val context = RuntimeEnvironment.getApplication()
        val preferences = context.getSharedPreferences("nuvio_theme_settings", Context.MODE_PRIVATE)
        preferences.edit().clear()
            .putString("selected_app_language", "en")
            .putBoolean(ProfileScopedKey.of("amoled_enabled"), true)
            .putString(ProfileScopedKey.of("selected_theme"), "CUSTOM")
            .commit()

        ThemeSettingsStorage.initialize(context)

        assertEquals("pt-BR", ThemeSettingsStorage.loadSelectedAppLanguage())
        assertEquals(true, ThemeSettingsStorage.loadAmoledEnabled())
        assertEquals("CUSTOM", ThemeSettingsStorage.loadSelectedTheme())
    }

    @Test
    fun oldDeviceAndProfileLanguagePreferencesMigrateToPortuguese() {
        val context = RuntimeEnvironment.getApplication()
        val preferences = context.getSharedPreferences("nuvio_theme_settings", Context.MODE_PRIVATE)
        for (language in listOf("device", "en", "fr", "invalid")) {
            preferences.edit().clear()
                .putString(ProfileScopedKey.of("selected_app_language"), language).commit()
            languagePreferences().edit().clear().commit()
            ThemeSettingsStorage.initialize(context)
            assertEquals("pt-BR", ThemeSettingsStorage.loadSelectedAppLanguage())
            assertEquals("pt-BR", languagePreferences().getString("selected_app_language", null))
        }
    }

    @Test
    fun languageMigrationSurvivesReinitializationAndProfileSync() {
        val context = RuntimeEnvironment.getApplication()
        ThemeSettingsStorage.initialize(context)
        ThemeSettingsStorage.replaceFromSyncPayload(buildJsonObject {})
        assertEquals("pt-BR", ThemeSettingsStorage.loadSelectedAppLanguage())
        assertEquals("pt-BR", languagePreferences().getString("selected_app_language", null))
    }

    @Test
    fun languageSurvivesLogoutAccountWipeAndRestart() {
        val context = RuntimeEnvironment.getApplication()
        com.nuvio.app.core.storage.PlatformLocalAccountDataCleaner.initialize(context)
        for (choice in listOf("pt-BR", "en")) {
            ThemeSettingsStorage.saveSelectedAppLanguage(choice)
            com.nuvio.app.core.storage.PlatformLocalAccountDataCleaner.wipe()
            assertEquals(choice, ThemeSettingsStorage.loadSelectedAppLanguage())
            ThemeSettingsStorage.initialize(context) // next launch after logout / new login
            assertEquals(choice, ThemeSettingsStorage.loadSelectedAppLanguage())
        }
    }

    @Test
    fun explicitChoiceSavedByEarlierObaflixMigrationIsKept() {
        val context = RuntimeEnvironment.getApplication()
        languagePreferences().edit().clear().commit()
        context.getSharedPreferences("nuvio_theme_settings", Context.MODE_PRIVATE).edit().clear()
            .putString("selected_app_language", "en")
            .putBoolean("obaflix_pt_br_initialized", true)
            .commit()
        ThemeSettingsStorage.initialize(context)
        assertEquals("en", ThemeSettingsStorage.loadSelectedAppLanguage())
    }

    @Test
    fun inPlaceConfigurationChangeOnOldAndroidRestoresAppLocale() {
        val original = android.os.LocaleList.getDefault()
        try {
            // What the system does to the process when the player rotates the screen.
            android.os.LocaleList.setDefault(android.os.LocaleList.forLanguageTags("en-US"))
            ThemeSettingsStorage.restoreAppLocaleAsDefault(sdkInt = 34)
            assertEquals("en-US", java.util.Locale.getDefault().toLanguageTag()) // 13+: LocaleManager handles it
            ThemeSettingsStorage.restoreAppLocaleAsDefault(sdkInt = 29)
            assertEquals("pt-BR", java.util.Locale.getDefault().toLanguageTag())
            assertEquals("pt-BR", androidx.compose.ui.text.intl.Locale.current.toLanguageTag())
            // Labels built outside composition (e.g. the "Movie" badge, player loading status).
            assertEquals("Filme", kotlinx.coroutines.runBlocking {
                org.jetbrains.compose.resources.getString(Res.string.media_movie)
            })

            android.os.LocaleList.setDefault(android.os.LocaleList.forLanguageTags("en-US"))
            ThemeSettingsStorage.saveSelectedAppLanguage("device")
            ThemeSettingsStorage.restoreAppLocaleAsDefault(sdkInt = 29)
            assertEquals("en-US", java.util.Locale.getDefault().toLanguageTag()) // "device" follows the system
        } finally {
            android.os.LocaleList.setDefault(original)
        }
    }

    @Test
    @Config(sdk = [29]) // the S9+ release where the reset happens
    fun guardUndoesAnyLocaleResetAndRefreshesText() {
        val original = android.os.LocaleList.getDefault()
        try {
            val epoch = ObaflixLocaleGuard.epoch.value
            assertEquals(false, ObaflixLocaleGuard.reassert("teste")) // nothing to undo
            // What a WebView (Unity ad, extractor) or an in-place rotation does to the process.
            android.os.LocaleList.setDefault(android.os.LocaleList.forLanguageTags("en-US"))
            assertEquals(true, ObaflixLocaleGuard.reassert("teste"))
            assertEquals(epoch + 1, ObaflixLocaleGuard.epoch.value) // rendered text re-resolves
            assertEquals("Filme", kotlinx.coroutines.runBlocking {
                org.jetbrains.compose.resources.getString(Res.string.media_movie)
            })
            // Android 13+ never needs it.
            android.os.LocaleList.setDefault(android.os.LocaleList.forLanguageTags("en-US"))
            assertEquals(false, ObaflixLocaleGuard.reassert("teste", sdkInt = 34))
        } finally {
            android.os.LocaleList.setDefault(original)
        }
    }

    @Test
    fun explicitLanguageChoiceAfterMigrationIsPreservedAcrossRestarts() {
        ThemeSettingsStorage.saveSelectedAppLanguage("en")
        ThemeSettingsStorage.initialize(RuntimeEnvironment.getApplication())
        assertEquals("en", ThemeSettingsStorage.loadSelectedAppLanguage())
    }

}
