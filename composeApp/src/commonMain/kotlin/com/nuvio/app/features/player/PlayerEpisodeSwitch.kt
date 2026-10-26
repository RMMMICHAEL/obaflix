package com.nuvio.app.features.player

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import androidx.compose.ui.layout.ContentScale
import com.nuvio.app.features.details.MetaVideo
import com.nuvio.app.integration.obaflix.ObaflixPlaybackGate

internal enum class EpisodeSwitchPhase { PREPARING, STARTING, FAILED }

/** The episode being started from the player: shown at once, before any ad. */
internal data class EpisodeSwitchUi(
    val episode: MetaVideo,
    val label: String,
    val phase: EpisodeSwitchPhase = EpisodeSwitchPhase.PREPARING,
    val message: String? = null,
)

internal fun episodeSwitchLabel(episode: MetaVideo): String {
    val tag = if (episode.season != null && episode.episode != null) "T${episode.season} · E${episode.episode}" else null
    return listOfNotNull(tag, episode.title.takeIf { it.isNotBlank() }).joinToString(" — ").ifBlank { "Episódio" }
}

/** Status line for [phase]; the gate says whether an ad is being shown or confirmed. */
internal fun episodeSwitchStatus(phase: EpisodeSwitchPhase, adActive: Boolean): String = when {
    phase == EpisodeSwitchPhase.STARTING -> "Carregando player…"
    adActive -> "Preparando reprodução…"
    else -> "Preparando episódio"
}

@Composable
internal fun EpisodeSwitchOverlay(
    ui: EpisodeSwitchUi,
    onRetry: () -> Unit,
    onCancel: () -> Unit,
    artwork: String? = null,
    modifier: Modifier = Modifier,
) {
    val adActive by ObaflixPlaybackGate.anuncioEmCurso.collectAsState()
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black)
            // Swallows every touch: no double taps while the transition runs.
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
        contentAlignment = Alignment.Center,
    ) {
        // The title's backdrop (else its poster) under a soft dark veil; plain black only when there is neither.
        if (artwork != null) {
            AsyncImage(model = artwork, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            Box(modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.62f)))
        }
        Column(
            modifier = Modifier.padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(ui.label, color = Color.White, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
            if (ui.phase == EpisodeSwitchPhase.FAILED) {
                Text(ui.message.orEmpty(), color = Color.White.copy(alpha = 0.85f), textAlign = TextAlign.Center)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = onRetry) { Text("Tentar novamente") }
                    TextButton(onClick = onCancel) { Text("Cancelar", color = Color.White) }
                }
            } else {
                CircularProgressIndicator(color = Color.White, modifier = Modifier.size(36.dp))
                Text(episodeSwitchStatus(ui.phase, adActive), color = Color.White.copy(alpha = 0.85f))
            }
        }
    }
}

/**
 * The episode switch in progress, kept at process level: the player's runtime state dies with an Activity recreation (it
 * did right after the Rewarded), but the ad gate and the source search live outside it. The new runtime finds the
 * pending episode here and resumes it; the search request is deduplicated and a confirmed ad grant is reused, so
 * nothing is asked twice and nothing is released without the server's confirmation.
 */
internal object EpisodeSwitchResume {
    private var parentMetaId: String? = null
    private var episode: MetaVideo? = null

    fun begin(parentMetaId: String, episode: MetaVideo) {
        this.parentMetaId = parentMetaId
        this.episode = episode
    }

    /** Ended: started, failed, cancelled or handed to the manual list. A failed switch is never resumed on its own. */
    fun clear() {
        parentMetaId = null
        episode = null
    }

    fun pendingFor(parentMetaId: String): MetaVideo? = episode.takeIf { this.parentMetaId == parentMetaId }
}
