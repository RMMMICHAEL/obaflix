package com.obaflix.tv.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp

/**
 * Margem de seguranca da tela de TV.
 *
 * Televisor antigo por HDMI ainda corta as bordas (overscan): parte do quadro
 * simplesmente nao aparece. A recomendacao do Android TV e manter 5% de folga
 * em cada lado, e e o que aplicamos — em fracao da tela, nao em dp fixo, para
 * valer igual em 720p, 1080p e 4K.
 *
 * Nada essencial pode ser desenhado fora daqui. Fundo e imagem de destaque
 * podem sangrar de proposito; texto, foco e botao, nunca.
 */
private const val FRACAO_HORIZONTAL = 0.05f
private const val FRACAO_VERTICAL = 0.05f

@Composable
fun margemSegura(): PaddingValues {
    val config = LocalConfiguration.current
    return PaddingValues(
        horizontal = (config.screenWidthDp * FRACAO_HORIZONTAL).dp,
        vertical = (config.screenHeightDp * FRACAO_VERTICAL).dp,
    )
}

/** Aplica a margem de seguranca ao elemento. */
@Composable
fun Modifier.areaSegura(): Modifier = this.padding(margemSegura())
