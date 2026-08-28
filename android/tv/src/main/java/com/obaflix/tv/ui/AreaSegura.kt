package com.obaflix.tv.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.Dp
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

/**
 * So a folga lateral.
 *
 * As fileiras precisam dela separada porque nao podem receber a margem como
 * padding do elemento: o card tem de poder rolar ate a borda fisica da tela.
 * La ela entra como `contentPadding`, que empurra o conteudo sem encurtar a
 * fileira.
 */
@Composable
fun margemHorizontal(): Dp {
    val config = LocalConfiguration.current
    return (config.screenWidthDp * FRACAO_HORIZONTAL).dp
}

@Composable
fun margemVertical(): Dp {
    val config = LocalConfiguration.current
    return (config.screenHeightDp * FRACAO_VERTICAL).dp
}

@Composable
fun margemSegura(): PaddingValues =
    PaddingValues(horizontal = margemHorizontal(), vertical = margemVertical())

/** Aplica a margem de seguranca ao elemento. */
@Composable
fun Modifier.areaSegura(): Modifier = this.padding(margemSegura())

/** Largura da tela em dp — usada para calcular quantas colunas cabem na grade. */
@Composable
fun larguraTelaDp(): Int = LocalConfiguration.current.screenWidthDp
