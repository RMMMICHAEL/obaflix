package com.nuvio.app.features.player

import android.app.Application
import android.content.Context
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ClassicPlayerLayoutDefaultTest {
    @BeforeTest
    fun initialize() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("nuvio_player_settings", Context.MODE_PRIVATE).edit().clear().commit()
        PlayerSettingsStorage.initialize(context)
        PlayerSettingsRepository.clearLocalState()
    }

    @AfterTest
    fun clearState() {
        PlayerSettingsRepository.clearLocalState()
    }

    @Test
    fun classicLayoutIsOnWhenNothingWasChosen() {
        assertTrue(PlayerSettingsUiState().useLegacyPlayerLayout)
        PlayerSettingsRepository.ensureLoaded()
        assertNull(PlayerSettingsStorage.loadUseLegacyPlayerLayout()) // default is not written as a choice
        assertTrue(PlayerSettingsRepository.uiState.value.useLegacyPlayerLayout)
    }

    @Test
    fun explicitChoiceIsKept() {
        PlayerSettingsStorage.saveUseLegacyPlayerLayout(false) // saved before this version
        PlayerSettingsRepository.ensureLoaded()
        assertFalse(PlayerSettingsRepository.uiState.value.useLegacyPlayerLayout)

        PlayerSettingsRepository.setUseLegacyPlayerLayout(true)
        PlayerSettingsRepository.onProfileChanged()
        assertTrue(PlayerSettingsRepository.uiState.value.useLegacyPlayerLayout)
        assertEquals(true, PlayerSettingsStorage.loadUseLegacyPlayerLayout())
    }
}
