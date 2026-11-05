package com.nuvio.app.features.settings

import android.app.Application
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Alignment
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import com.nuvio.app.features.player.PlayerToolbar
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "pt-rBR-w400dp-h900dp-port")
class ObaflixBrandUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun oversizedCallersAreCapped() {
        compose.setContent {
            MaterialTheme {
                AppBrandWordmark(Modifier.width(180.dp).height(120.dp).testTag("brand"))
            }
        }
        compose.onNodeWithTag("brand").assertHeightIsEqualTo(36.dp)
        compose.onNodeWithText("OBAFLIX").assertIsDisplayed()
    }

    @Test fun narrowPlayerToolbarKeepsBrandAndCloseButtonAndHidesTogether() {
        val visible = mutableStateOf(true)
        compose.setContent {
            MaterialTheme {
                Box(Modifier.width(320.dp)) {
                    AnimatedVisibility(visible.value) {
                        PlayerToolbar(
                            isLocked = false, onLockToggle = {}, onBack = {},
                            onSwitchEngineClick = {}, onPartyClick = {},
                        )
                    }
                }
            }
        }
        // One discreet mark only: no "OBAFLIX" text competing with the title in the player.
        compose.onNodeWithContentDescription("Obaflix").assertIsDisplayed()
        compose.onNodeWithText("OBAFLIX").assertDoesNotExist()
        val buttons = compose.onAllNodes(hasClickAction()).assertCountEquals(4).fetchSemanticsNodes()
        val brand = compose.onNodeWithContentDescription("Obaflix").fetchSemanticsNode().boundsInRoot
        check(brand.width <= 23f * compose.density.density) // ~22dp, never oversized
        check(buttons.all { it.boundsInRoot.left >= brand.right })
        compose.runOnIdle { visible.value = false }
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Obaflix").assertDoesNotExist()
    }

    @Test fun splashShowsOneLargeCenteredMark() {
        compose.setContent {
            MaterialTheme { com.nuvio.app.AppLoadingContent(Modifier.fillMaxSize()) }
        }
        val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val mark = compose.onNodeWithContentDescription("Obaflix").fetchSemanticsNode().boundsInRoot
        val d = compose.density.density
        check(mark.width >= 119f * d && kotlin.math.abs(mark.width - mark.height) < 1f) { "size/proportion: $mark" }
        check(kotlin.math.abs(mark.center.x - root.center.x) < 1f) { "not centered: $mark in $root" }
        compose.onNodeWithText("OBAFLIX").assertDoesNotExist()
    }

    @Test fun bottomBarMarkSitsBetweenSearchAndLibraryWithoutBlockingTabs() {
        val taps = mutableListOf<String>()
        val tabs = listOf("Início", "Buscar", "Biblioteca", "Perfil")
        compose.setContent {
            MaterialTheme {
                Box(Modifier.width(400.dp).height(64.dp)) {
                    Row(Modifier.fillMaxSize()) {
                        tabs.forEach { tab ->
                            Box(Modifier.weight(1f).fillMaxHeight().testTag(tab).clickable { taps += tab })
                        }
                    }
                    ObaflixNavMark(Modifier.align(Alignment.Center).size(40.dp))
                }
            }
        }
        val mark = compose.onNodeWithContentDescription("Obaflix").fetchSemanticsNode().boundsInRoot
        val search = compose.onNodeWithTag("Buscar").fetchSemanticsNode().boundsInRoot
        val library = compose.onNodeWithTag("Biblioteca").fetchSemanticsNode().boundsInRoot
        check(kotlin.math.abs(mark.center.x - search.right) < 1f && search.right == library.left) { "$mark $search $library" }
        tabs.forEach { compose.onNodeWithTag(it).performClick() } // each tab's center stays free
        compose.onRoot().performTouchInput { click(center) } // the mark itself passes the tap through
        check(taps.take(4) == tabs && taps.size == 5 && taps[4] in listOf("Buscar", "Biblioteca")) { "$taps" }
        compose.onAllNodesWithContentDescription("Obaflix").assertCountEquals(1)
    }
}
