package com.nuvio.app.features.settings

import android.app.Application
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.nuvio.app.core.ui.NuvioTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "pt-rBR-w400dp-h900dp-port")
class ObaflixSwitchProfileUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun profileSectionOffersSwitchProfile() {
        var switches = 0
        compose.setContent {
            NuvioTheme {
                LazyColumn {
                    settingsRootContent(
                        isTablet = false, onPlaybackClick = {}, onAppearanceClick = {}, onAdvancedClick = {},
                        onNotificationsClick = {}, onContentDiscoveryClick = {}, onIntegrationsClick = {},
                        onTrackingClick = {}, onSupportersContributorsClick = {}, onLegalPrivacyClick = {},
                        onAccountClick = {}, onSwitchProfileClick = { switches++ },
                    )
                }
            }
        }
        compose.onNodeWithText("Alternar Perfil").assertIsDisplayed().performClick()
        assertEquals(1, switches)
    }
}
