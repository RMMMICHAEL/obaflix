package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.focusGroup
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
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
 * Busca.
 *
 * Teclado a esquerda, resultados a direita — a divisao classica de televisao,
 * porque so existem quatro setas e um OK. Nada aqui depende de teclado de
 * sistema: em TV Box o teclado virtual do Android aparece por cima da tela,
 * come metade do quadro e navega mal com controle remoto.
 *
 * O trafego e contido pelo intervalo antes de consultar: quem digita "vingado"
 * gera uma requisicao, nao sete. Como /api/search consulta o Postgres e ainda
 * chama o TMDB, cada tecla disparando busca sairia caro nos dois.
 */
private val LINHAS_TECLADO = listOf(
    "ABCDEF",
    "GHIJKL",
    "MNOPQR",
    "STUVWX",
    "YZ0123",
    "456789",
)

@Composable
fun ColumnScope.TelaBusca() {
    var termo by remember { mutableStateOf("") }
    var resultados by remember { mutableStateOf<List<Item>>(emptyList()) }
    var buscando by remember { mutableStateOf(false) }
    val primeiraTecla = remember { FocusRequester() }
    val margem = margemHorizontal()

    LaunchedEffect(termo) {
        if (termo.length < 2) {
            resultados = emptyList()
            buscando = false
            return@LaunchedEffect
        }
        // Pausa antes de consultar: e o que transforma uma palavra inteira numa
        // unica ida ao servidor.
        buscando = true
        delay(450)
        resultados = ApiObaflix.buscar(termo)
        buscando = false
    }

    LaunchedEffect(Unit) { runCatching { primeiraTecla.requestFocus() } }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .weight(1f)
            .padding(start = margem, end = margem, top = 8.dp, bottom = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(36.dp),
    ) {
        Column(
            modifier = Modifier.width(360.dp).fillMaxHeight().focusGroup(),
        ) {
            CaixaTermo(termo)
            EspacoV(18.dp)
            Teclado(
                primeiraTecla = primeiraTecla,
                aoDigitar = { termo += it },
                aoApagar = { termo = termo.dropLast(1) },
                aoLimpar = { termo = "" },
            )
        }

        Box(Modifier.weight(1f).fillMaxHeight()) {
            when {
                resultados.isNotEmpty() -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(Medidas.PosterLargura + Medidas.EspacoCards),
                    modifier = Modifier.fillMaxSize().focusGroup(),
                    contentPadding = PaddingValues(bottom = margemVertical(), top = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(Medidas.EspacoCards),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    itemsIndexed(resultados, key = { _, item -> item.tipo + item.id }) { indice, item ->
                        CardPoster(
                            item = item,
                            chaveFoco = enderecoDe("busca", indice),
                            aoAbrir = { Navegacao.abrirDetalhe(it) },
                        )
                    }
                }

                buscando -> Aviso("Procurando…")
                termo.length >= 2 -> Aviso("Nada encontrado para \"" + termo + "\".")
                else -> Aviso("Digite para procurar em todo o catálogo.")
            }
        }
    }
}

/** O que ja foi digitado, com um cursor piscando — sinal de que a tela espera. */
@Composable
private fun CaixaTermo(termo: String) {
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
            .height(64.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Cores.Superficie)
            .border(2.dp, Cores.SuperficieAlta, RoundedCornerShape(10.dp))
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Text(
            text = if (termo.isEmpty()) "Buscar" else termo + (if (cursor) "|" else " "),
            color = if (termo.isEmpty()) Cores.TextoApagado else Cores.Texto,
            fontSize = Escala.Corpo,
            fontWeight = FontWeight.Bold,
            maxLines = 1,
        )
    }
}

@Composable
private fun Teclado(
    primeiraTecla: FocusRequester,
    aoDigitar: (String) -> Unit,
    aoApagar: () -> Unit,
    aoLimpar: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        LINHAS_TECLADO.forEachIndexed { linha, letras ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                letras.forEachIndexed { coluna, letra ->
                    Tecla(
                        rotulo = letra.toString(),
                        modifier = if (linha == 0 && coluna == 0) {
                            Modifier.focusRequester(primeiraTecla)
                        } else {
                            Modifier
                        },
                        aoClicar = { aoDigitar(letra.toString()) },
                    )
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Tecla("espaço", largura = 112.dp) { aoDigitar(" ") }
            Tecla("apagar", largura = 112.dp) { aoApagar() }
            Tecla("limpar", largura = 112.dp) { aoLimpar() }
        }
    }
}

@Composable
private fun Tecla(
    rotulo: String,
    modifier: Modifier = Modifier,
    largura: androidx.compose.ui.unit.Dp = 52.dp,
    aoClicar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.12f)
    val forma = RoundedCornerShape(8.dp)

    Box(
        modifier = modifier
            .size(width = largura, height = 52.dp)
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
            fontSize = if (rotulo.length > 1) Escala.Miudo else Escala.Corpo,
            fontWeight = FontWeight.Bold,
        )
    }
}
