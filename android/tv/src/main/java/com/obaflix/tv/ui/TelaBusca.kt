package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.ui.componentes.CardPoster
import com.obaflix.tv.ui.componentes.EspacoV
import com.obaflix.tv.ui.componentes.enderecoDe
import com.obaflix.tv.ui.componentes.escalaFoco
import com.obaflix.tv.ui.componentes.escalar
import com.obaflix.tv.ui.componentes.focavel
import kotlinx.coroutines.delay

/**
 * Busca — activity_vodsearch da referencia, agora **responsiva**.
 *
 * Teclado a esquerda, resultados a direita. Nada tem largura ou altura fixa: as
 * teclas sao dimensionadas a partir do espaco disponivel (BoxWithConstraints),
 * de modo que o teclado inteiro cabe na altura util em 720p, 1080p e afins, e a
 * grade da direita calcula quantas colunas cabem na largura que sobra. Era esse
 * o defeito — medidas fixas empurravam teclado e resultados para fora da tela.
 *
 * DIREITA no teclado leva aos resultados; ESQUERDA nos resultados volta ao
 * teclado (a busca de foco do Compose resolve pela geometria, ja que um esta a
 * esquerda do outro). A consulta so dispara depois de uma pausa de digitacao —
 * uma palavra vira uma requisicao, nao uma por tecla.
 */
private val LINHAS_TECLADO = listOf(
    "ABCDEF", "GHIJKL", "MNOPQR", "STUVWX", "YZ0123", "456789",
)

@Composable
fun ColumnScope.TelaBusca() {
    var termo by remember { mutableStateOf("") }
    var resultados by remember { mutableStateOf<List<Item>>(emptyList()) }
    var populares by remember { mutableStateOf<List<Item>>(emptyList()) }
    var buscando by remember { mutableStateOf(false) }
    val primeiraTecla = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        populares = ApiObaflix.filmes(1, null, null, "popular")?.itens.orEmpty()
    }

    LaunchedEffect(termo) {
        if (termo.length < 2) {
            resultados = emptyList()
            buscando = false
            return@LaunchedEffect
        }
        buscando = true
        delay(450)
        resultados = ApiObaflix.buscar(termo)
        buscando = false
    }

    // Foco inicial na primeira tecla, com insistencia (mesma raiz do problema de
    // D-pad no boot: um pedido unico dispara cedo demais).
    LaunchedEffect(Unit) {
        repeat(12) {
            runCatching { primeiraTecla.requestFocus() }
            delay(60)
        }
    }

    BoxWithConstraints(Modifier.fillMaxWidth().weight(1f)) {
        val larguraTotal = maxWidth
        val alturaTotal = maxHeight

        // ── Geometria do teclado, derivada do espaco ──────────────────────────
        val gap = 8.dp
        val padTeclado = 20.dp
        val larguraTeclado = (larguraTotal * 0.40f).coerceIn(280.dp, 460.dp)
        val larguraTecla = ((larguraTeclado - padTeclado * 2 - gap * 5) / 6)
        // 8 linhas de teclas: apagar/limpar (1) + 6 de letras + espaco (1). Mais
        // a caixa de texto no topo. keyH nunca ultrapassa a fatia vertical.
        val alturaCaixa = 52.dp
        val alturaPorLinha = ((alturaTotal - alturaCaixa - gap * 11) / 8).coerceIn(26.dp, 48.dp)
        val alturaTecla = minOf(alturaPorLinha, larguraTecla + 4.dp)

        Row(Modifier.fillMaxSize()) {
            // ── Teclado ───────────────────────────────────────────────────────
            Column(
                modifier = Modifier
                    .width(larguraTeclado)
                    .fillMaxHeight()
                    .background(Color.Black.copy(alpha = 0.5f))
                    .padding(horizontal = padTeclado, vertical = 12.dp)
                    .focusGroup(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(gap),
            ) {
                CaixaTermo(termo, alturaCaixa)
                Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                    val w = larguraTecla * 3 + gap * 2
                    Tecla("apagar", w, alturaTecla) { termo = termo.dropLast(1) }
                    Tecla("limpar", w, alturaTecla) { termo = "" }
                }
                LINHAS_TECLADO.forEachIndexed { linha, letras ->
                    Row(horizontalArrangement = Arrangement.spacedBy(gap)) {
                        letras.forEachIndexed { coluna, letra ->
                            Tecla(
                                rotulo = letra.toString(),
                                largura = larguraTecla,
                                altura = alturaTecla,
                                modifier = if (linha == 0 && coluna == 0) Modifier.focusRequester(primeiraTecla) else Modifier,
                                aoClicar = { termo += letra },
                            )
                        }
                    }
                }
                Tecla("espaço", larguraTecla * 6 + gap * 5, alturaTecla) { termo += " " }
            }

            // ── Resultados / Populares ────────────────────────────────────────
            val larguraResultados = larguraTotal - larguraTeclado - 24.dp
            val colunas = ((larguraResultados.value - margemHorizontal().value) /
                (Medidas.PosterLargura.value + Medidas.EspacoCards.value)).toInt().coerceIn(3, 8)

            Column(Modifier.weight(1f).fillMaxHeight().padding(start = 24.dp)) {
                val mostrandoResultado = termo.length >= 2
                Text(
                    text = if (mostrandoResultado) "Resultados" else "Populares",
                    color = Cores.Texto,
                    fontSize = Escala.Secao,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(top = 16.dp, bottom = 8.dp),
                )
                val lista = if (mostrandoResultado) resultados else populares
                Box(Modifier.weight(1f)) {
                    when {
                        lista.isNotEmpty() -> LazyVerticalGrid(
                            columns = GridCells.Fixed(colunas),
                            modifier = Modifier.fillMaxSize().focusGroup(),
                            contentPadding = PaddingValues(end = margemHorizontal(), bottom = margemVertical()),
                            horizontalArrangement = Arrangement.spacedBy(Medidas.EspacoCards),
                            verticalArrangement = Arrangement.spacedBy(14.dp),
                        ) {
                            itemsIndexed(lista, key = { _, item -> item.tipo + item.id }) { indice, item ->
                                CardPoster(
                                    item = item,
                                    chaveFoco = enderecoDe("busca", indice),
                                    aoAbrir = { Navegacao.abrirDetalhe(it) },
                                )
                            }
                        }

                        buscando -> Aviso("Procurando…")
                        mostrandoResultado -> Aviso("Nada encontrado para \"" + termo + "\".")
                        else -> Aviso("Digite para procurar em todo o catálogo.")
                    }
                }
            }
        }
    }
}

@Composable
private fun CaixaTermo(termo: String, altura: Dp) {
    var cursor by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(530)
            cursor = !cursor
        }
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(altura)
            .clip(RoundedCornerShape(8.dp))
            .background(Cores.Superficie)
            .border(2.dp, Cores.SuperficieAlta, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text = if (termo.isEmpty()) "Buscar" else termo + (if (cursor) "|" else " "),
            color = if (termo.isEmpty()) Cores.TextoApagado else Cores.Texto,
            fontSize = Escala.Rotulo,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            softWrap = false,
        )
    }
}

@Composable
private fun Tecla(
    rotulo: String,
    largura: Dp,
    altura: Dp,
    modifier: Modifier = Modifier,
    aoClicar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.14f)
    val forma = RoundedCornerShape(6.dp)
    val letra = rotulo.length == 1

    Box(
        modifier = modifier
            .size(width = largura, height = altura)
            .escalar(escala)
            .clip(forma)
            .background(if (focado) Cores.FocoHalo else Cores.Superficie)
            .border(
                width = if (focado) 0.dp else 1.dp,
                color = if (focado) Color.Transparent else Cores.SuperficieAlta,
                shape = forma,
            )
            .focavel(interacao = interacao, aoClicar = aoClicar),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = rotulo,
            color = if (focado) Color(0xFF101014) else Cores.Texto,
            fontSize = if (letra) 17.sp else 12.sp,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
            softWrap = false,
        )
    }
}
