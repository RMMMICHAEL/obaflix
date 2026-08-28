package com.obaflix.tv.ui

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
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Item
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce

/**
 * Busca com controle remoto.
 *
 * Teclado à esquerda, resultados à direita, atualizando enquanto se digita. É
 * o desenho certo para TV porque evita o pior padrão do meio: digitar às cegas
 * e só então descobrir que não achou nada.
 *
 * O teclado é próprio, e não o do sistema: o teclado do Android em TV Box tapa
 * meia tela, muda de fabricante para fabricante e às vezes nem abre sem mouse.
 *
 * Alfabeto em grade de seis colunas, e não em QWERTY: com D-Pad o que importa é
 * a distância em teclas até a letra, e a ordem alfabética é a que a pessoa
 * consegue prever sem procurar.
 */
private val TECLAS: List<String> =
    ('A'..'Z').map { it.toString() } + ('0'..'9').map { it.toString() }

private const val COLUNAS_TECLADO = 6

@OptIn(FlowPreview::class)
@Composable
fun TelaBusca(aoAbrir: (Item) -> Unit) {
    var termo by remember { mutableStateOf("") }
    var resultados by remember { mutableStateOf<List<Item>>(emptyList()) }
    var buscando by remember { mutableStateOf(false) }

    // Debounce: cada letra é um movimento de controle, e disparar consulta a
    // cada tecla gastaria invocação na Vercel para termo que a pessoa ainda
    // está montando. 350 ms é curto o bastante para parecer instantâneo.
    LaunchedEffect(Unit) {
        snapshotFlow { termo }
            .debounce(350)
            .collectLatest { atual ->
                if (atual.length < 2) {
                    resultados = emptyList()
                    buscando = false
                    return@collectLatest
                }
                buscando = true
                resultados = ApiObaflix.buscar(atual)
                buscando = false
            }
    }

    val margem = margemSegura()

    Row(
        modifier = Modifier.fillMaxSize().padding(
            start = margem.calculateLeftPadding(LayoutDirection.Ltr),
            end = margem.calculateRightPadding(LayoutDirection.Ltr),
            bottom = margem.calculateBottomPadding(),
        ),
        horizontalArrangement = Arrangement.spacedBy(36.dp),
    ) {
        // ── Teclado ──────────────────────────────────────────────────────────
        Column(
            modifier = Modifier.width(300.dp).fillMaxHeight().focusGroup(),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // O que já foi digitado, sempre visível acima do teclado.
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(Cores.Superficie)
                    .padding(horizontal = 16.dp, vertical = 14.dp),
            ) {
                Text(
                    text = termo.ifBlank { "Digite para buscar" },
                    color = if (termo.isBlank()) Cores.TextoFraco else Cores.Texto,
                    fontSize = Escala.Corpo,
                    maxLines = 1,
                )
            }

            TECLAS.chunked(COLUNAS_TECLADO).forEach { linha ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    linha.forEach { tecla ->
                        Tecla(tecla) { termo += tecla }
                    }
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Tecla("espaço", largura = 128.dp) { if (termo.isNotEmpty()) termo += " " }
                Tecla("apagar", largura = 110.dp) { termo = termo.dropLast(1) }
            }
        }

        // ── Resultados ───────────────────────────────────────────────────────
        Box(modifier = Modifier.weight(1f).fillMaxHeight()) {
            when {
                termo.length < 2 ->
                    Aviso("Escolha as letras com o controle.\nOs resultados aparecem aqui.")

                buscando && resultados.isEmpty() -> Aviso("Buscando…")

                resultados.isEmpty() -> Aviso("Nada encontrado para “$termo”.")

                else -> Column {
                    Text(
                        text = "${resultados.size} resultado${if (resultados.size == 1) "" else "s"}",
                        color = Cores.TextoFraco,
                        fontSize = Escala.Rotulo,
                        modifier = Modifier.padding(bottom = 12.dp),
                    )
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(minSize = 160.dp),
                        modifier = Modifier.fillMaxSize().focusGroup(),
                        horizontalArrangement = Arrangement.spacedBy(16.dp),
                        verticalArrangement = Arrangement.spacedBy(20.dp),
                        contentPadding = PaddingValues(bottom = 24.dp),
                    ) {
                        items(resultados, key = { "${it.tipo}:${it.id}" }) { item ->
                            CardConteudo(item, aoAbrir = aoAbrir)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Aviso(texto: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text = texto,
            color = Cores.TextoFraco,
            fontSize = Escala.Corpo,
            fontWeight = FontWeight.Normal,
        )
    }
}

@Composable
private fun Tecla(rotulo: String, largura: androidx.compose.ui.unit.Dp = 40.dp, aoAcionar: () -> Unit) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()

    Box(
        modifier = Modifier
            .then(if (rotulo.length == 1) Modifier.size(40.dp) else Modifier.width(largura).height(40.dp))
            .clip(RoundedCornerShape(6.dp))
            .background(if (focado) Cores.Destaque else Cores.Superficie)
            .border(
                width = if (focado) 2.dp else 0.dp,
                color = if (focado) Cores.FocoHalo else Color.Transparent,
                shape = RoundedCornerShape(6.dp),
            )
            .focusable(interactionSource = interacao)
            .aoConfirmar(aoAcionar),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = rotulo,
            color = if (focado) Color.White else Cores.Texto,
            fontSize = if (rotulo.length == 1) Escala.Corpo else Escala.Rotulo,
        )
    }
}
