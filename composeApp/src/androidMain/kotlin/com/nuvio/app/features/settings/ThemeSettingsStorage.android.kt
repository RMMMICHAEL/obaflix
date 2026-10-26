package com.nuvio.app.features.settings

import android.app.LocaleManager
import android.os.Build
import android.os.LocaleList
import android.content.Context
import android.content.SharedPreferences
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import com.nuvio.app.core.sync.decodeSyncBoolean
import com.nuvio.app.core.sync.decodeSyncString
import com.nuvio.app.core.sync.encodeSyncBoolean
import com.nuvio.app.core.sync.encodeSyncString
import com.nuvio.app.core.storage.ProfileScopedKey
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

actual object ThemeSettingsStorage {
    private const val preferencesName = "nuvio_theme_settings"
    // Language is a device preference, not account data: kept apart so logout's account wipe
    // (PlatformLocalAccountDataCleaner clears nuvio_theme_settings) cannot reset it.
    private const val languagePreferencesName = "obaflix_app_language"
    private const val selectedThemeKey = "selected_theme"
    private const val customThemeColorsKey = "custom_theme_colors"
    private const val amoledEnabledKey = "amoled_enabled"
    private const val liquidGlassNativeTabBarEnabledKey = "liquid_glass_native_tab_bar_enabled"
    private const val selectedAppLanguageKey = "selected_app_language"
    private const val obaflixLanguageInitializedKey = "obaflix_pt_br_initialized"
    private const val NAV_BAR_STYLE_KEY = "nav_bar_style"
    private const val navBarGlowEnabledKey = "nav_bar_glow_enabled"
    private val profileScopedSyncKeys = listOf(
        selectedThemeKey,
        customThemeColorsKey,
        amoledEnabledKey,
        navBarGlowEnabledKey,
        liquidGlassNativeTabBarEnabledKey,
        NAV_BAR_STYLE_KEY,
    )

    private var preferences: SharedPreferences? = null
    private var languagePreferences: SharedPreferences? = null
    private var applicationContext: Context? = null

    fun initialize(context: Context) {
        applicationContext = context.applicationContext
        val prefs = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
        preferences = prefs
        val language = context.getSharedPreferences(languagePreferencesName, Context.MODE_PRIVATE)
        languagePreferences = language
        // Migrate inherited Nuvio/device language once; preserve later user choices and all other settings.
        if (!language.getBoolean(obaflixLanguageInitializedKey, false)) {
            // A choice made after an earlier Obaflix migration (flag in the old file) is kept.
            val earlierChoice = prefs.getString(selectedAppLanguageKey, null)
                ?.takeIf { prefs.getBoolean(obaflixLanguageInitializedKey, false) }
            language.edit()
                .putString(selectedAppLanguageKey, earlierChoice ?: AppLanguage.PORTUGUESE_BRAZIL.code)
                .putBoolean(obaflixLanguageInitializedKey, true)
                .apply()
            prefs.edit().remove(selectedAppLanguageKey).remove(obaflixLanguageInitializedKey).apply()
        }
        applySelectedAppLanguage(loadSelectedAppLanguage() ?: AppLanguage.PORTUGUESE_BRAZIL.code)
        // Labels resolved outside composition (getString) read Locale.getDefault() from the first screen on.
        restoreAppLocaleAsDefault()
    }

    /**
     * Android < 13 only: a configuration change the Activity handles itself (the player rotating the
     * screen) resets the process default Locale to the system language, and Compose resources read
     * that default (stringResource and getString alike). Restores the app language without recreating the Activity. Android 13+ gets the
     * app locale in the configuration from LocaleManager, so nothing to do there.
     */
    /** Returns true when the default had been reset and was restored. */
    fun restoreAppLocaleAsDefault(sdkInt: Int = Build.VERSION.SDK_INT): Boolean {
        if (sdkInt >= 33) return false
        val tag = loadSelectedAppLanguage()?.takeUnless { it.equals("device", ignoreCase = true) } ?: return false
        val locales = LocaleList.forLanguageTags(tag)
        if (locales.isEmpty || LocaleList.getDefault().get(0) == locales.get(0)) return false
        LocaleList.setDefault(locales)
        return true
    }

    actual fun loadSelectedTheme(): String? =
        preferences?.getString(ProfileScopedKey.of(selectedThemeKey), null)

    actual fun saveSelectedTheme(themeName: String) {
        preferences
            ?.edit()
            ?.putString(ProfileScopedKey.of(selectedThemeKey), themeName)
            ?.apply()
    }

    actual fun loadCustomThemeColors(): String? =
        preferences?.getString(ProfileScopedKey.of(customThemeColorsKey), null)

    actual fun saveCustomThemeColors(colors: String) {
        preferences
            ?.edit()
            ?.putString(ProfileScopedKey.of(customThemeColorsKey), colors)
            ?.apply()
    }

    actual fun loadAmoledEnabled(): Boolean? =
        preferences?.let { prefs ->
            val key = ProfileScopedKey.of(amoledEnabledKey)
            if (prefs.contains(key)) prefs.getBoolean(key, false) else null
        }

    actual fun saveAmoledEnabled(enabled: Boolean) {
        preferences
            ?.edit()
            ?.putBoolean(ProfileScopedKey.of(amoledEnabledKey), enabled)
            ?.apply()
    }

    actual fun loadNavBarGlowEnabled(): Boolean? =
        preferences?.let { prefs ->
            val key = ProfileScopedKey.of(navBarGlowEnabledKey)
            if (prefs.contains(key)) prefs.getBoolean(key, false) else null
        }

    actual fun saveNavBarGlowEnabled(enabled: Boolean) {
        preferences
            ?.edit()
            ?.putBoolean(ProfileScopedKey.of(navBarGlowEnabledKey), enabled)
            ?.apply()
    }

    actual fun loadLiquidGlassNativeTabBarEnabled(): Boolean? =
        preferences?.let { prefs ->
            val key = ProfileScopedKey.of(liquidGlassNativeTabBarEnabledKey)
            if (prefs.contains(key)) prefs.getBoolean(key, false) else null
        }

    actual fun saveLiquidGlassNativeTabBarEnabled(enabled: Boolean) {
        preferences
            ?.edit()
            ?.putBoolean(ProfileScopedKey.of(liquidGlassNativeTabBarEnabledKey), enabled)
            ?.apply()
    }

    actual fun loadSelectedAppLanguage(): String? {
        val value = languagePreferences?.getString(selectedAppLanguageKey, null)
        if (value != null) return value
        val legacy = preferences?.getString(ProfileScopedKey.of(selectedAppLanguageKey), null)
        if (legacy != null) saveSelectedAppLanguage(legacy)
        return legacy ?: AppLanguage.PORTUGUESE_BRAZIL.code
    }

    actual fun saveSelectedAppLanguage(languageCode: String) {
        languagePreferences
            ?.edit()
            ?.putString(selectedAppLanguageKey, languageCode)
            ?.apply()
    }

    actual fun applySelectedAppLanguage(languageCode: String) {
        val locales = if (languageCode.equals("device", ignoreCase = true)) {
            LocaleListCompat.getEmptyLocaleList()
        } else {
            LocaleListCompat.forLanguageTags(languageCode)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            // initialize runs before AppCompat has an Activity delegate on a cold start.
            applicationContext?.getSystemService(LocaleManager::class.java)?.applicationLocales =
                LocaleList.forLanguageTags(locales.toLanguageTags())
        } else {
            AppCompatDelegate.setApplicationLocales(locales)
        }
    }

    actual fun loadNavBarStyle(): String? =
        preferences?.getString(ProfileScopedKey.of(NAV_BAR_STYLE_KEY), null)

    actual fun saveNavBarStyle(styleKey: String) {
        preferences
            ?.edit()
            ?.putString(ProfileScopedKey.of(NAV_BAR_STYLE_KEY), styleKey)
            ?.apply()
    }

    actual fun exportToSyncPayload(): JsonObject = buildJsonObject {
        loadSelectedTheme()?.let { put(selectedThemeKey, encodeSyncString(it)) }
        loadCustomThemeColors()?.let { put(customThemeColorsKey, encodeSyncString(it)) }
        loadNavBarGlowEnabled()?.let { put(navBarGlowEnabledKey, encodeSyncBoolean(it)) }
        loadAmoledEnabled()?.let { put(amoledEnabledKey, encodeSyncBoolean(it)) }
        loadLiquidGlassNativeTabBarEnabled()?.let { put(liquidGlassNativeTabBarEnabledKey, encodeSyncBoolean(it)) }
        loadNavBarStyle()?.let { put(NAV_BAR_STYLE_KEY, encodeSyncString(it)) }
    }

    actual fun replaceFromSyncPayload(payload: JsonObject) {
        preferences?.edit()?.apply {
            profileScopedSyncKeys.forEach { remove(ProfileScopedKey.of(it)) }
        }?.apply()

        payload.decodeSyncString(selectedThemeKey)?.let(::saveSelectedTheme)
        payload.decodeSyncString(customThemeColorsKey)?.let(::saveCustomThemeColors)
        payload.decodeSyncBoolean(navBarGlowEnabledKey)?.let(::saveNavBarGlowEnabled)
        payload.decodeSyncBoolean(amoledEnabledKey)?.let(::saveAmoledEnabled)
        payload.decodeSyncBoolean(liquidGlassNativeTabBarEnabledKey)?.let(::saveLiquidGlassNativeTabBarEnabled)
        payload.decodeSyncString(NAV_BAR_STYLE_KEY)?.let(::saveNavBarStyle)
        applySelectedAppLanguage(loadSelectedAppLanguage() ?: AppLanguage.PORTUGUESE_BRAZIL.code)
    }
}
