package com.nuvio.app.core.ui

import android.app.Application
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.nuvio.app.core.ui.jelly.JellyMotion
import com.nuvio.app.core.ui.jelly.JellyTabTargets
import org.junit.Rule
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.Test
import kotlin.test.assertEquals

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w480dp-h800dp-mdpi")
class ObaflixNavMarkSlotTest {
    @get:Rule
    val compose = createComposeRule()

    private val clicks = mutableListOf<String>()
    private lateinit var motion: JellyMotion

    private fun setContent(labelFraction: Float) {
        motion = JellyMotion(0, 5).apply { resize(400f, 64f, 5) }
        val labels = listOf("Início", "Buscar", "", "Biblioteca", "Perfil")
        val items = labels.mapIndexed { i, label ->
            FloatingNavigationItem(
                label = label,
                selected = i == 0,
                onClick = { clicks += label },
                decorative = i == 2,
                content = if (i == 2) {
                    { Box(Modifier.fillMaxSize().testTag("mark")) }
                } else null,
            )
        }
        compose.setContent {
            CompositionLocalProvider(LocalDensity provides Density(1f)) {
                NuvioTheme {
                    Box(Modifier.size(400.dp, 64.dp).pointerInput(Unit) { detectJellyTabGestures(motion, 1f, { items }, { false }) }) {
                        JellyTabTargets(items, labelFraction, motion, false, Modifier.matchParentSize())
                    }
                }
            }
        }
    }

    @Test
    fun markSitsInTheCenterSlotAndNeverNavigates() {
        setContent(labelFraction = 1f)
        val mark = compose.onNodeWithTag("mark", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val search = compose.onNodeWithContentDescription("Buscar").fetchSemanticsNode().boundsInRoot
        val library = compose.onNodeWithContentDescription("Biblioteca").fetchSemanticsNode().boundsInRoot
        assertEquals(200f, mark.center.x, 1f, "mark=$mark search=$search library=$library") // bar center
        assert(mark.left >= search.right && mark.right <= library.left) { "overlap: $search $mark $library" }
        assertEquals(40f, mark.width, 0.5f)
        assertEquals(mark.width, mark.height, 0.5f)

        compose.onNodeWithTag("mark", useUnmergedTree = true).performTouchInput { click() }
        compose.runOnIdle {
            repeat(240) { motion.advance(1.0 / 60) }
            assertEquals(0f, motion.frame.position, 0.0001f) // stays on the selected tab
            assertEquals(emptyList(), clicks)
        }
        compose.onNodeWithContentDescription("Biblioteca").performTouchInput { click() }
        compose.runOnIdle { assertEquals(listOf("Biblioteca"), clicks) }
        compose.onAllNodesWithContentDescription("").assertCountEquals(0) // no empty, focusable tab
    }

    @Test
    fun markShrinksWithTheCollapsedBar() {
        setContent(labelFraction = 0f)
        val mark = compose.onNodeWithTag("mark", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertEquals(34f, mark.width, 0.5f, "mark=$mark")
        assertEquals(200f, mark.center.x, 1f)
    }
}
