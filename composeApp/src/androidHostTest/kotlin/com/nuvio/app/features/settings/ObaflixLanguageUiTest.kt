package com.nuvio.app.features.settings

import android.app.Application
import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.nuvio.app.core.ui.NuvioTheme
import com.nuvio.app.features.auth.AuthScreen
import nuvio.composeapp.generated.resources.*
import org.jetbrains.compose.resources.stringResource
import org.junit.Rule
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.BeforeTest
import kotlin.test.Test

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "pt-rBR-w400dp-h900dp-port")
class ObaflixLanguageUiTest {
    @get:Rule
    val compose = createComposeRule()

    @BeforeTest
    fun initialize() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("nuvio_theme_settings", Context.MODE_PRIVATE).edit().clear().commit()
        ThemeSettingsStorage.initialize(context)
    }

    @Test
    fun authenticationActuallyRendersPortuguese() {
        compose.setContent { NuvioTheme { AuthScreen() } }
        compose.onNodeWithText("Entrar").assertIsDisplayed()
        compose.onNodeWithText("Senha").assertIsDisplayed()
        compose.onNodeWithText("Sign In").assertDoesNotExist()
    }

    @Test
    fun usedScreenLabelsResolveAndRenderPortuguese() {
        val labels = listOf(
            Res.string.compose_nav_home to "Início",
            Res.string.media_movies to "Filmes",
            Res.string.media_series to "Séries",
            Res.string.compose_nav_search to "Busca",
            Res.string.compose_nav_profile to "Perfil",
            Res.string.compose_settings_page_account to "Minha conta",
            Res.string.compose_settings_page_addons to "Addons",
            Res.string.compose_settings_page_playback to "Preferências de reprodução",
            Res.string.detail_btn_play to "Reproduzir",
            Res.string.provider_downloaded to "Baixado",
            Res.string.player_engine_switch_title to "Trocar para ExoPlayer?",
        )
        compose.setContent {
            NuvioTheme {
                Column {
                    labels.forEach { (resource, _) ->
                        Text(if (resource == Res.string.player_engine_switch_title) {
                            stringResource(resource, "ExoPlayer")
                        } else {
                            stringResource(resource)
                        })
                    }
                }
            }
        }
        labels.forEach { (_, text) -> compose.onNodeWithText(text).assertIsDisplayed() }
    }
}
