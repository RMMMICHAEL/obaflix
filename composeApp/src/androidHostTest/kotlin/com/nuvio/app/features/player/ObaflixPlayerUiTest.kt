package com.nuvio.app.features.player

import android.app.Application
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import org.junit.Rule
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ObaflixPlayerUiTest {
    @get:Rule
    val compose = createComposeRule()

    private fun SemanticsNodeInteraction.bounds(): Rect = fetchSemanticsNode().boundsInRoot

    private fun assertLoadingStackHasNoOverlap() {
        compose.setContent {
            MaterialTheme {
                OpeningOverlay(
                    artwork = null,
                    logo = null,
                    title = "Título do conteúdo",
                    onBack = {},
                    horizontalSafePadding = 0.dp,
                    message = "Buffering…",
                    sourceLabel = "Addon · FenixFlix",
                    onSwitchSource = {},
                )
            }
        }
        val root = compose.onRoot().bounds()
        val stack = listOf(
            compose.onNodeWithText("Buffering…").bounds(),
            compose.onNodeWithText("Addon · FenixFlix").bounds(),
            compose.onNodeWithText("Trocar fonte").bounds(),
            compose.onNodeWithText("Demorando para começar?", substring = true).bounds(),
        )
        stack.zipWithNext().forEach { (above, below) ->
            assertTrue(above.bottom <= below.top, "overlap: $above vs $below")
        }
        stack.forEach { assertTrue(it.top >= root.top && it.bottom <= root.bottom, "outside screen: $it in $root") }
        compose.onNodeWithText("Trocar fonte").assertIsDisplayed()
    }

    @Test
    @Config(qualifiers = "w360dp-h640dp-port")
    fun loadingTextsNeverOverlapInPortrait() = assertLoadingStackHasNoOverlap()

    @Test
    @Config(qualifiers = "w640dp-h360dp-land")
    fun loadingTextsNeverOverlapInLandscape() = assertLoadingStackHasNoOverlap()

    @Test
    @Config(qualifiers = "w600dp-h320dp-land")
    fun loadingTextsNeverOverlapOnShortScreens() = assertLoadingStackHasNoOverlap()

    @Test
    fun playerToolbarOffersDownloadAndCastNextToOneDiscreetMark() {
        var downloads = 0
        var casts = 0
        compose.setContent {
            MaterialTheme {
                PlayerToolbar(
                    isLocked = false,
                    onLockToggle = {},
                    onBack = {},
                    onDownloadClick = { downloads++ },
                    onCastClick = { casts++ },
                )
            }
        }
        compose.onNodeWithContentDescription("Obaflix").assertIsDisplayed()
        compose.onNodeWithContentDescription("Baixar").performClick()
        compose.onNodeWithContentDescription("Transmitir").performClick()
        assertEquals(1, downloads)
        assertEquals(1, casts)
    }

    private fun assertBothLayoutsOfferTheSameObaflixActions(legacy: Boolean) {
        var downloads = 0
        var casts = 0
        compose.setContent {
            MaterialTheme {
                PlayerControlsShell(
                    title = "Título", streamTitle = "1080p", providerName = "FenixFlix",
                    seasonNumber = null, episodeNumber = null, episodeTitle = null,
                    playbackSnapshot = PlayerPlaybackSnapshot(isLoading = false, durationMs = 60_000),
                    displayedPositionMs = 0, metrics = PlayerLayoutMetrics.fromWidth(800.dp),
                    resizeMode = PlayerResizeMode.entries.first(), isLocked = false, useLegacyLayout = legacy,
                    onLockToggle = {}, onBack = {}, onTogglePlayback = {}, onSeekBack = {}, onSeekForward = {},
                    onResizeModeClick = {}, onSpeedClick = {}, onSubtitleClick = {}, onAudioClick = {},
                    onDownloadClick = { downloads++ }, onCastClick = { casts++ },
                    onScrubChange = {}, onScrubFinished = {}, horizontalSafePadding = 0.dp,
                )
            }
        }
        compose.onAllNodesWithContentDescription("Obaflix").assertCountEquals(1)
        compose.onNodeWithContentDescription("Baixar").performClick()
        compose.onNodeWithContentDescription("Transmitir").performClick()
        assertEquals(1, downloads)
        assertEquals(1, casts)
    }

    @Test
    @Config(qualifiers = "w800dp-h400dp-land")
    fun classicLayoutKeepsDownloadCastAndMark() = assertBothLayoutsOfferTheSameObaflixActions(legacy = true)

    @Test
    @Config(qualifiers = "w800dp-h400dp-land")
    fun modernLayoutKeepsDownloadCastAndMark() = assertBothLayoutsOfferTheSameObaflixActions(legacy = false)
}
