package com.nuvio.app.features.settings

import android.app.Application
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.printToString
import com.nuvio.app.core.ui.NuvioTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "pt-rBR-w400dp-h4000dp-port")
class ObaflixLegalPrivacyUiTest {
    @get:Rule val compose = createComposeRule()

    private val opened = mutableListOf<String>()
    private val uriHandler = object : UriHandler {
        override fun openUri(uri: String) { opened += uri }
    }

    private fun show() = compose.setContent {
        CompositionLocalProvider(LocalUriHandler provides uriHandler) {
            NuvioTheme { LazyColumn { legalPrivacyContent(isTablet = false) } }
        }
    }

    @Test fun legalAreaHasOnlyPrivacyTermsAndAccountDeletion() {
        show()
        val tree = compose.onRoot(useUnmergedTree = true).printToString(maxDepth = Int.MAX_VALUE)
        for (kept in listOf("Política de Privacidade", "Termos de Uso", "Excluir Conta")) assertTrue(kept in tree, "missing: $kept")
        for (gone in listOf("Nuvio", "TMDB", "IntroDB", "IMDb", "GNU General Public License", "Licenças", "Atribuiç")) {
            assertFalse(gone in tree, "still shown: $gone")
        }
    }

    @Test fun eachAccessOpensItsRealSitePageOnce() {
        show()
        for (title in listOf("Política de Privacidade", "Termos de Uso", "Excluir Conta")) {
            compose.onNodeWithText(title, useUnmergedTree = true).performClick()
        }
        assertEquals(
            listOf("https://obaflixbr.com/privacidade", "https://obaflixbr.com/termos", "https://obaflixbr.com/excluir-conta"),
            opened,
        )
    }
}
