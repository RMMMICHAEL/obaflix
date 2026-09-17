package com.obaflix.tv.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.obaflix.tv.R
import com.obaflix.tv.player.AlvoDaEscolha
import com.obaflix.tv.player.DirecaoDpad
import com.obaflix.tv.player.vizinhoNaEscolha
import com.obaflix.tv.ui.componentes.BotaoTv
import com.obaflix.tv.ui.componentes.focavel
import kotlinx.coroutines.delay

internal const val ROTULO_CONTINUAR_GRATIS = "CONTINUAR GRÁTIS"

/**
 * Onde cada card esta no ultimo quadro do anuncio (1920×1080), em fracao da
 * imagem. Medido no quadro final do video; o poster embutido e esse mesmo
 * quadro, entao player e poster casam com as mesmas areas.
 */
private data class AreaNoQuadro(val x: Float, val y: Float, val largura: Float, val altura: Float)

private val AREAS = mapOf(
    AlvoDaEscolha.Basico to AreaNoQuadro(x = 115f / 1920, y = 160f / 1080, largura = 517f / 1920, altura = 733f / 1080),
    AlvoDaEscolha.Plus to AreaNoQuadro(x = 683f / 1920, y = 148f / 1080, largura = 547f / 1920, altura = 769f / 1080),
    AlvoDaEscolha.Premium to AreaNoQuadro(x = 1282f / 1920, y = 160f / 1080, largura = 515f / 1920, altura = 733f / 1080),
)

/** Topo do botao "Continuar gratis": na faixa de reflexo abaixo dos cards. */
private const val TOPO_DO_CONTINUAR = 0.86f

private const val PROPORCAO_DO_QUADRO = 16f / 9f

/**
 * A escolha depois do fim real do anuncio.
 *
 * ## O quadro
 *
 * O player promocional continua composto por baixo, parado no ultimo quadro.
 * Por cima, o mesmo quadro como imagem estatica: ha TVs que apagam a superficie
 * de video no `STATE_ENDED`, e na volta dos planos o player ja nao existe. Os
 * dois sao desenhados em "fit" 16:9 centralizado, entao nada se desloca.
 *
 * ## O cursor
 *
 * Quatro areas focaveis do Compose — nunca os pixels do video. Os cards sao
 * transparentes e ganham so borda e brilho claros no foco, para a arte do
 * anuncio continuar sendo o card. Cada seta tem destino explicito
 * (`vizinhoNaEscolha`); sem `enter`, sem busca 2D sobre o video.
 */
@Composable
fun EscolhaFinalDoAnuncio(focoInicial: AlvoDaEscolha, aoEscolher: (AlvoDaEscolha) -> Unit) {
    val requisitores = remember { AlvoDaEscolha.entries.associateWith { FocusRequester() } }
    var focado by remember { mutableStateOf<AlvoDaEscolha?>(null) }
    var ultimoPlano by remember { mutableStateOf<AlvoDaEscolha?>(focoInicial.takeIf { it.ehPlano }) }

    LaunchedEffect(Unit) {
        repeat(12) {
            if (focado != null) return@LaunchedEffect
            withFrameNanos { }
            runCatching { requisitores.getValue(focoInicial).requestFocus() }
            delay(50)
        }
    }

    fun Modifier.navegacao(alvo: AlvoDaEscolha): Modifier = this
        .focusRequester(requisitores.getValue(alvo))
        .focusProperties {
            left = requisitores.getValue(vizinhoNaEscolha(alvo, DirecaoDpad.Esquerda, ultimoPlano))
            right = requisitores.getValue(vizinhoNaEscolha(alvo, DirecaoDpad.Direita, ultimoPlano))
            up = requisitores.getValue(vizinhoNaEscolha(alvo, DirecaoDpad.Cima, ultimoPlano))
            down = requisitores.getValue(vizinhoNaEscolha(alvo, DirecaoDpad.Baixo, ultimoPlano))
        }
        .onFocusChanged { estado ->
            if (estado.isFocused) {
                focado = alvo
                if (alvo.ehPlano) ultimoPlano = alvo
            } else if (focado == alvo) {
                focado = null
            }
        }

    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val (larguraQuadro, alturaQuadro) =
            if (maxWidth / maxHeight > PROPORCAO_DO_QUADRO) (maxHeight * PROPORCAO_DO_QUADRO) to maxHeight
            else maxWidth to (maxWidth / PROPORCAO_DO_QUADRO)

        Box(Modifier.size(larguraQuadro, alturaQuadro)) {
            Image(
                painter = painterResource(R.drawable.anuncio_escolha_final),
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
            )

            AREAS.forEach { (alvo, area) ->
                AreaDoPlano(
                    rotulo = "Plano " + alvo.name,
                    raio = larguraQuadro * 0.014f,
                    modifier = Modifier
                        .offset(larguraQuadro * area.x, alturaQuadro * area.y)
                        .size(larguraQuadro * area.largura, alturaQuadro * area.altura)
                        .navegacao(alvo),
                    aoClicar = { aoEscolher(alvo) },
                )
            }

            BotaoTv(
                texto = ROTULO_CONTINUAR_GRATIS,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = alturaQuadro * TOPO_DO_CONTINUAR)
                    .wrapContentWidth(Alignment.CenterHorizontally)
                    .navegacao(AlvoDaEscolha.ContinuarGratis),
                aoClicar = { aoEscolher(AlvoDaEscolha.ContinuarGratis) },
            )
        }
    }
}

/** Area transparente sobre um card da arte; no foco, so borda e brilho claros. */
@Composable
private fun AreaDoPlano(rotulo: String, raio: Dp, modifier: Modifier, aoClicar: () -> Unit) {
    val interacao = remember { MutableInteractionSource() }
    val foco by interacao.collectIsFocusedAsState()
    val forma = RoundedCornerShape(raio)
    Box(
        modifier
            .semantics { contentDescription = rotulo }
            .then(
                if (foco) {
                    Modifier
                        .border(8.dp, Color.White.copy(alpha = 0.18f), forma)
                        .border(3.dp, Color.White.copy(alpha = 0.92f), forma)
                } else {
                    Modifier
                },
            )
            .focavel(interacao = interacao, aoClicar = aoClicar),
    )
}
