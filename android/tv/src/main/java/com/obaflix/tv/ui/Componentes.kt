package com.obaflix.tv.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Fileira
import com.obaflix.tv.catalogo.Item

/**
 * Peças que toda tela de TV usa.
 *
 * O foco é o único ponteiro que existe numa televisão, então ele precisa ser
 * inequívoco a três metros: o card cresce, ganha borda clara e revela o título.
 * Um sinal sozinho — só a borda, só a escala — não se enxerga de longe.
 */

/** Aciona com OK. Controle de TV Box manda DPAD_CENTER ou ENTER, nunca os dois. */
fun Modifier.aoConfirmar(acao: () -> Unit): Modifier = onKeyEvent { evento ->
    val ok = evento.type == KeyEventType.KeyUp &&
        (evento.key == Key.DirectionCenter || evento.key == Key.Enter)
    if (ok) acao()
    ok
}

@Composable
fun CardConteudo(
    item: Item,
    paisagem: Boolean = false,
    modifier: Modifier = Modifier,
    aoAbrir: (Item) -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    // Animar em vez de saltar: o salto seco faz a fileira inteira parecer travar
    // em aparelho fraco, mesmo quando o quadro sai no tempo.
    val escala by animateFloatAsState(if (focado) 1.08f else 1f, label = "escala")

    Column(modifier = modifier.width(if (paisagem) 300.dp else 170.dp)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(if (paisagem) 16f / 9f else 2f / 3f)
                // Escala no card, não na coluna: o título abaixo não deve crescer
                // junto, senão a fileira treme a cada movimento do controle.
                .scale(escala)
                .clip(RoundedCornerShape(8.dp))
                .background(Cores.Superficie)
                .border(
                    width = if (focado) 3.dp else 0.dp,
                    color = if (focado) Cores.FocoHalo else Color.Transparent,
                    shape = RoundedCornerShape(8.dp),
                )
                .focusable(interactionSource = interacao)
                .aoConfirmar { aoAbrir(item) },
        ) {
            val arte = if (paisagem) {
                ApiObaflix.imagem(item.background ?: item.poster, "w780")
            } else {
                ApiObaflix.imagem(item.poster ?: item.background, "w500")
            }
            if (arte != null) {
                AsyncImage(
                    model = arte,
                    contentDescription = item.titulo,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                // Sem arte, o título ocupa o card — melhor do que retângulo vazio,
                // que o usuário lê como "carregando" e fica esperando.
                Text(
                    text = item.titulo,
                    color = Cores.TextoFraco,
                    fontSize = Escala.Rotulo,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.align(Alignment.Center).padding(10.dp),
                )
            }

            if (item.progresso > 0f) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .fillMaxWidth()
                        .height(4.dp)
                        .background(Color.Black.copy(alpha = 0.55f)),
                ) {
                    Box(
                        Modifier.fillMaxWidth(item.progresso).fillMaxHeight()
                            .background(Cores.Destaque),
                    )
                }
            }
        }

        // Título só no card focado. Com todos visíveis a fileira vira parede de
        // texto, e o pôster já identifica o que a pessoa procura.
        if (focado) {
            Text(
                text = item.rotuloEpisodio?.let { "${item.titulo} · $it" } ?: item.titulo,
                color = Cores.Texto,
                fontSize = Escala.Rotulo,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
    }
}

/**
 * Fileira horizontal.
 *
 * `focusGroup` faz a linha ser tratada como uma unidade pela travessia de foco,
 * em vez de percorrida item a item — o que, além de correto, evita alcançar um
 * card que a lista já reciclou.
 *
 * O `LazyListState` vem de fora quando a tela quer restaurar a posição ao
 * voltar de um detalhe. A pessoa estava no décimo card; voltar para o primeiro
 * seria perder o lugar dela.
 */
@Composable
fun FileiraConteudo(
    fileira: Fileira,
    estado: LazyListState = rememberLazyListState(),
    modifier: Modifier = Modifier,
    aoAbrir: (Item) -> Unit,
) {
    Column(modifier = modifier) {
        Text(
            text = fileira.titulo,
            color = Cores.Texto,
            fontSize = Escala.Secao,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(bottom = 12.dp),
        )
        LazyRow(
            state = estado,
            modifier = Modifier.focusGroup(),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            // Folga à direita: o último card não pode colar na borda, e a folga
            // também deixa entrever que a fileira continua.
            contentPadding = PaddingValues(end = 64.dp),
        ) {
            items(fileira.itens, key = { it.id }) { item ->
                CardConteudo(item, fileira.paisagem, aoAbrir = aoAbrir)
            }
        }
    }
}

/** Botão de TV. Cresce e acende no foco, como os cards. */
@Composable
fun BotaoTv(
    texto: String,
    modifier: Modifier = Modifier,
    destaque: Boolean = false,
    aoAcionar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(
                when {
                    focado -> Cores.Destaque
                    destaque -> Cores.Superficie
                    else -> Cores.Superficie.copy(alpha = 0.6f)
                },
            )
            .border(
                width = if (focado) 2.dp else 0.dp,
                color = if (focado) Cores.FocoHalo else Color.Transparent,
                shape = RoundedCornerShape(8.dp),
            )
            .focusable(interactionSource = interacao)
            .aoConfirmar(aoAcionar)
            .padding(horizontal = 24.dp, vertical = 12.dp),
    ) {
        Text(
            text = texto,
            color = if (focado) Color.White else Cores.Texto,
            fontSize = Escala.Rotulo,
            maxLines = 1,
        )
    }
}

@Composable
fun MensagemCentral(texto: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text = texto, color = Cores.TextoFraco, fontSize = Escala.Corpo)
    }
}
