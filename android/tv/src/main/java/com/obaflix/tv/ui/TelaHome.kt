package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Home
import com.obaflix.tv.catalogo.Item
import kotlinx.coroutines.flow.collectLatest

/**
 * Home.
 *
 * Destaque no topo e fileiras abaixo — a forma que qualquer pessoa reconhece
 * numa televisão, e que funciona com quatro setas e um OK.
 *
 * Cada fileira guarda a própria posição de rolagem, então voltar de um detalhe
 * devolve a pessoa ao card em que ela estava, e não ao começo da fileira.
 */
@Composable
fun TelaHome(aoAbrir: (Item) -> Unit) {
    var home by remember { mutableStateOf<Home?>(null) }
    var erro by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        val resultado = ApiObaflix.home()
        if (resultado == null) erro = true else home = resultado
    }

    val dados = home
    when {
        erro -> MensagemCentral("Não foi possível carregar o catálogo.")
        dados == null -> MensagemCentral("Carregando…")
        else -> {
            val margem = margemSegura()
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = margem.calculateLeftPadding(LayoutDirection.Ltr),
                    bottom = margem.calculateBottomPadding(),
                ),
                verticalArrangement = Arrangement.spacedBy(30.dp),
            ) {
                dados.destaque?.let { destaque -> item { Destaque(destaque) } }
                items(dados.fileiras, key = { it.titulo }) { fileira ->
                    val estado = rememberLazyListState()
                    FileiraConteudo(fileira, estado, aoAbrir = aoAbrir)
                }
            }
        }
    }
}

/**
 * Faixa de destaque.
 *
 * Não é focável de propósito: seria um alvo enorme entre a barra e a primeira
 * fileira, e obrigaria uma descida a mais toda vez que alguém quisesse chegar
 * ao catálogo. Quem quer aquele título o encontra na fileira logo abaixo.
 */
@Composable
private fun Destaque(item: Item) {
    Box(modifier = Modifier.fillMaxWidth().height(320.dp)) {
        ApiObaflix.imagem(item.background ?: item.poster, "w1280")?.let { url ->
            AsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(12.dp)),
            )
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clip(RoundedCornerShape(12.dp))
                    .background(
                        Brush.horizontalGradient(
                            listOf(Cores.Fundo, Cores.Fundo.copy(alpha = 0.7f), Color.Transparent),
                        ),
                    ),
            )
        }

        Column(
            modifier = Modifier.fillMaxHeight().fillMaxWidth(0.5f).padding(32.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = item.titulo,
                color = Cores.Texto,
                fontSize = Escala.Titulo,
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            item.sinopse?.let {
                Box(Modifier.height(12.dp))
                Text(
                    text = it,
                    color = Cores.TextoFraco,
                    fontSize = Escala.Corpo,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/**
 * Catálogo de uma seção — Filmes, Séries, Animes ou Desenhos.
 *
 * Grade em vez de fileiras: aqui a pessoa está procurando, não passeando, e a
 * grade mostra muito mais capa por tela.
 *
 * A próxima página entra quando o foco chega perto do fim, com folga — pedir só
 * na última linha faria a pessoa esperar olhando para o vazio.
 */
@Composable
fun TelaSecao(secao: SecaoTv, aoAbrir: (Item) -> Unit) {
    val itens = remember(secao) { mutableStateListOf<Item>() }
    var pagina by remember(secao) { mutableStateOf(0) }
    var acabou by remember(secao) { mutableStateOf(false) }
    var carregando by remember(secao) { mutableStateOf(false) }
    val estado = rememberLazyGridState()

    suspend fun carregarProxima() {
        if (carregando || acabou) return
        carregando = true
        val novos = ApiObaflix.catalogo(secao.chave, pagina + 1)
        if (novos.isEmpty()) {
            acabou = true
        } else {
            itens.addAll(novos)
            pagina += 1
        }
        carregando = false
    }

    LaunchedEffect(secao) { carregarProxima() }

    val pertoDoFim by remember(secao) {
        derivedStateOf {
            val ultimo = estado.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            itens.isNotEmpty() && ultimo >= itens.size - 12
        }
    }
    LaunchedEffect(secao) {
        snapshotFlow { pertoDoFim }.collectLatest { se -> if (se) carregarProxima() }
    }

    if (itens.isEmpty()) {
        MensagemCentral(if (carregando) "Carregando…" else "Nada por aqui ainda.")
        return
    }

    val margem = margemSegura()
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 170.dp),
        state = estado,
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(
            start = margem.calculateLeftPadding(LayoutDirection.Ltr),
            end = margem.calculateRightPadding(LayoutDirection.Ltr),
            bottom = margem.calculateBottomPadding(),
        ),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        items(itens, key = { it.id }) { item -> CardConteudo(item, aoAbrir = aoAbrir) }
    }
}
