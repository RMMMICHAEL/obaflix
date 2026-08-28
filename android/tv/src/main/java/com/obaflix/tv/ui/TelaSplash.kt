package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.obaflix.tv.BuildConfig

/**
 * Abertura do aplicativo.
 *
 * Nao decide nada e nao tem temporizador proprio: fica no ar enquanto o estado
 * for Inicializando, e sai quando `SessaoAtual` publicar o resultado. O piso de
 * tempo que evita o piscar da tela vive la, junto da verificacao — dois relogios
 * independentes acabariam se desencontrando.
 *
 * A versao no canto nao e enfeite: e diagnostico de campo. Quando alguem relata
 * um problema, e a primeira coisa a perguntar.
 */
@Composable
fun TelaSplash() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Cores.Fundo),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(96.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(Cores.Destaque),
            )
            Box(modifier = Modifier.height(24.dp))
            Text(
                text = "Obaflix",
                color = Cores.Texto,
                fontSize = Escala.Titulo,
                textAlign = TextAlign.Center,
            )
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .areaSegura(),
            contentAlignment = Alignment.BottomEnd,
        ) {
            Text(
                text = "TV ${BuildConfig.VERSION_NAME}",
                color = Cores.TextoFraco,
                fontSize = Escala.Rotulo,
            )
        }
    }
}
