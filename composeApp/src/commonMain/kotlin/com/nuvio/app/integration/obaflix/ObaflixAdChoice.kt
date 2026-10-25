package com.nuvio.app.integration.obaflix

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The voluntary choice the Rewarded requires, as a screen layer (no dialog): "Assistir anúncio e continuar" or cancel.
 * State lives here, not in an Activity, so it survives an Activity recreation while the question is open.
 */
internal object ObaflixAdChoice {
    private val _pending = MutableStateFlow<CompletableDeferred<Boolean>?>(null)

    val pending: StateFlow<CompletableDeferred<Boolean>?> get() = _pending

    /** True when the user chose to watch; false on cancel. Cancelling the caller removes the question. */
    suspend fun ask(): Boolean {
        val answer = CompletableDeferred<Boolean>()
        _pending.value?.complete(false)
        _pending.value = answer
        try {
            return answer.await()
        } finally {
            if (_pending.value === answer) _pending.value = null
        }
    }
}

@Composable
internal fun ObaflixAdChoiceHost(modifier: Modifier = Modifier) {
    val pending by ObaflixAdChoice.pending.collectAsState()
    val answer = pending ?: return
    val offerVisible = obaflixPremiumOfferVisible()
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.9f))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
        contentAlignment = Alignment.Center,
    ) {
        // The X replaces "Cancelar": closing answers "no" and nothing is released.
        TextButton(onClick = { answer.complete(false) }, modifier = Modifier.align(Alignment.TopEnd).padding(8.dp)) {
            Text("\u2715", color = Color.White.copy(alpha = 0.8f), fontSize = 22.sp)
        }
        Column(
            modifier = Modifier.padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Continuar com anúncio", color = Color.White, style = MaterialTheme.typography.titleLarge)
            Text(
                "Assistir ao anúncio libera a reprodução.",
                color = Color.White.copy(alpha = 0.8f),
                textAlign = TextAlign.Center,
            )
            Button(onClick = { answer.complete(true) }) { Text("Assistir anúncio e continuar") }
            if (offerVisible) {
                OutlinedButton(onClick = {
                    answer.complete(false) // the action is cancelled safely; the offer opens over it
                    ObaflixPremium.open()
                }) { Text("REMOVER ANÚNCIOS", color = Color.White) }
            }
        }
    }
}
