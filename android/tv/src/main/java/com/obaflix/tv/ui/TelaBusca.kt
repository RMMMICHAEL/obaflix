package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusGroup
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
 * Reproduz o activity_vodsearch: teclado a esquerda (letras em grade de 6 +
 * numeros + espaço/apagar/limpar) e, a direita, os resultados; enquanto nada foi
 * digitado, o painel da direita mostra "Populares". Nada depende de teclado de
 * sistema — em TV Box ele tapa meia tela e navega mal com controle.
 *
 * O trafego e contido pela pausa antes de consultar: uma palavra inteira vira
 * uma requisicao, nao uma por tecla — /api/search ainda chama o Postgres e o
 * TMDB, e cada tecla disparando busca sairia caro nos dois.
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

    LaunchedEffect(Unit) { runCatching { primeiraTecla.requestFocus() } }

    Row(Modifier.fillMaxWidth().weight(1f)) {
        // ── Teclado ──────────────────────────────────────────────────────────
        Column(
            modifier = Modifier
                .width(Medidas.TecladoLargura)
                .fillMaxHeight()
                .background(Color.Black.copy(alpha = 0.55f))
                .padding(start = 24.dp, end = 24.dp, top = 20.dp)
                .focusGroup(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            CaixaTermo(termo)
            EspacoV(14.dp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Tecla("apagar", largura = 108.dp) { termo = termo.dropLast(1) }
                Tecla("limpar", largura = 108.dp) { termo = "" }
            }
            EspacoV(10.dp)
            LINHAS_TECLADO.forEachIndexed { linha, letras ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                    letras.forEachIndexed { coluna, letra ->
                        Tecla(
                            rotulo = letra.toString(),
                            modifier = if (linha == 0 && coluna == 0) Modifier.focusRequester(primeiraTecla) else Modifier,
                            aoClicar = { termo += letra },
                        )
                    }
                }
            }
            EspacoV(12.dp)
            Tecla("espaço", largura = 224.dp) { termo += " " }
        }

        // ── Resultados / Populares ───────────────────────────────────────────
        Column(Modifier.weight(1f).fillMaxHeight().padding(start = 30.dp)) {
            val mostrandoResultado = termo.length >= 2
            Text(
                text = if (mostrandoResultado) "Resultados" else "Populares",
                color = Cores.Texto,
                fontSize = Escala.Secao,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.padding(top = 20.dp, bottom = 10.dp),
            )
            val lista = if (mostrandoResultado) resultados else populares
            Box(Modifier.weight(1f)) {
                when {
                    lista.isNotEmpty() -> LazyVerticalGrid(
                        columns = GridCells.Fixed(5),
                        modifier = Modifier.fillMaxSize().focusGroup(),
                        contentPadding = PaddingValues(end = margemHorizontal(), bottom = margemVertical()),
                        horizontalArrangement = Arrangement.spacedBy(Medidas.EspacoCards),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
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
            .height(60.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(Cores.Superficie)
            .border(2.dp, Cores.SuperficieAlta, RoundedCornerShape(8.dp))
            .padding(horizontal = 14.dp),
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
private fun Tecla(
    rotulo: String,
    modifier: Modifier = Modifier,
    largura: androidx.compose.ui.unit.Dp = 40.dp,
    aoClicar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.14f)
    val forma = RoundedCornerShape(6.dp)

    Box(
        modifier = modifier
            .size(width = largura, height = 44.dp)
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
