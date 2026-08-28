package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.foundation.rememberScrollState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Genero
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.navegacao.Aba
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.ui.componentes.CardPoster
import com.obaflix.tv.ui.componentes.EspacoV
import com.obaflix.tv.ui.componentes.LinhaMeta
import com.obaflix.tv.ui.componentes.Pilula
import com.obaflix.tv.ui.componentes.colunas
import com.obaflix.tv.ui.componentes.enderecoDe
import com.obaflix.tv.ui.componentes.escalaFoco
import com.obaflix.tv.ui.componentes.escalar
import com.obaflix.tv.ui.componentes.focavel

/**
 * Ordenacoes que a rota de catalogo aceita.
 *
 * Sao exatamente as do backend — nenhuma foi inventada para a televisao. Uma
 * opcao a mais aqui viraria um filtro que devolve a lista errada em silencio.
 */
private enum class Ordem(val rotulo: String, val chave: String) {
    Todos("Todos", "recente"),
    Populares("Populares", "popular"),
    Lancamentos("Lançamentos", "lancamento"),
    Nota("Melhor nota", "nota"),
    Az("A–Z", "az"),
}

/**
 * Tela de catalogo — Filmes, Series, Animes e Kids.
 *
 * As quatro abas usam a mesma tela porque, no backend, sao a mesma consulta com
 * um `tipo` diferente. Manter quatro copias divergiria na primeira correcao.
 *
 * Genero e ano nao sao listas fixas: saem dos proprios itens que chegaram na
 * primeira pagina. Assim nenhum atalho promete uma categoria que o catalogo nao
 * tem, e nao foi preciso criar rota nova no servidor para descobrir isso.
 */
@Composable
fun ColumnScope.TelaCatalogo(aba: Aba, aoFocarArte: (String?) -> Unit) {
    val tipo = when (aba) {
        Aba.Series -> "serie"
        Aba.Animes -> "anime"
        Aba.Kids -> "desenho"
        else -> null
    }

    var ordem by remember(aba) { mutableStateOf(Ordem.Todos) }
    var genero by remember(aba) { mutableStateOf<Genero?>(null) }
    var ano by remember(aba) { mutableStateOf<Int?>(null) }

    var itens by remember(aba) { mutableStateOf<List<Item>>(emptyList()) }
    var pagina by remember(aba) { mutableStateOf(1) }
    var paginas by remember(aba) { mutableStateOf(1) }
    var carregando by remember(aba) { mutableStateOf(true) }
    var erro by remember(aba) { mutableStateOf(false) }
    var recarga by remember(aba) { mutableStateOf(0) }

    // Vocabulario de filtros: congelado na primeira carga sem filtro. Se fosse
    // recalculado a cada resposta, escolher "Ação" faria as outras opcoes
    // sumirem da tela — e nao haveria como voltar.
    var generosConhecidos by remember(aba) { mutableStateOf<List<Genero>>(emptyList()) }
    var anosConhecidos by remember(aba) { mutableStateOf<List<Int>>(emptyList()) }

    val grade = rememberLazyGridState()
    val margem = margemHorizontal()
    val colunas = colunas(larguraTelaDp(), margem.value.toInt())

    suspend fun carregar(paginaAlvo: Int) {
        val resposta = if (tipo == null) {
            ApiObaflix.filmes(paginaAlvo, genero?.id, ano, ordem.chave)
        } else {
            ApiObaflix.series(tipo, paginaAlvo, genero?.id, ano, ordem.chave)
        }
        if (resposta == null) {
            erro = itens.isEmpty()
            carregando = false
            return
        }
        itens = if (paginaAlvo == 1) resposta.itens else itens + resposta.itens
        pagina = resposta.pagina
        paginas = resposta.paginas
        erro = false
        carregando = false

        if (generosConhecidos.isEmpty()) {
            generosConhecidos = resposta.itens.flatMap { it.generos }
                .distinctBy { it.id }
                .sortedBy { it.nome }
                .take(12)
        }
        if (anosConhecidos.isEmpty()) {
            anosConhecidos = resposta.itens.mapNotNull { it.ano }.distinct().sortedDescending().take(8)
        }
    }

    // Trocar um filtro recomeca da pagina 1 e rola para o topo — continuar no
    // meio da grade anterior mostraria um resultado que nao corresponde mais ao
    // que esta selecionado.
    LaunchedEffect(aba, ordem, genero, ano, recarga) {
        carregando = true
        itens = emptyList()
        carregar(1)
        runCatching { grade.scrollToItem(0) }
    }

    // Pagina seguinte quando o foco chega perto do fim. O gatilho e a posicao
    // visivel, nao um botao: em televisao ninguem procura "carregar mais".
    val precisaMais by remember {
        derivedStateOf {
            val ultimo = grade.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            ultimo >= itens.size - colunas * 2
        }
    }
    LaunchedEffect(Unit) {
        snapshotFlow { precisaMais }.collect { perto ->
            if (perto && !carregando && pagina < paginas && itens.isNotEmpty()) {
                carregando = true
                carregar(pagina + 1)
            }
        }
    }

    Box(Modifier.fillMaxWidth().weight(1f)) {
        when {
            itens.isNotEmpty() -> LazyVerticalGrid(
                columns = GridCells.Fixed(colunas),
                state = grade,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = margem, end = margem, top = 8.dp, bottom = margemVertical(),
                ),
                horizontalArrangement = Arrangement.spacedBy(Medidas.EspacoCards),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                item(span = { GridItemSpan(maxLineSpan) }, key = "cabecalho") {
                    Cabecalho(
                        aba = aba,
                        destaque = itens.first(),
                        ordem = ordem,
                        genero = genero,
                        ano = ano,
                        generos = generosConhecidos,
                        anos = anosConhecidos,
                        aoOrdem = { ordem = it },
                        aoGenero = { genero = it },
                        aoAno = { ano = it },
                        aoFocarArte = aoFocarArte,
                    )
                }

                itemsIndexed(itens, key = { _, item -> item.id }) { indice, item ->
                    CardPoster(
                        item = item,
                        chaveFoco = enderecoDe("grade-" + aba.name, indice),
                        aoFocar = { aoFocarArte(it.background) },
                        aoAbrir = { Navegacao.abrirDetalhe(it) },
                    )
                }

                if (pagina < paginas) {
                    item(span = { GridItemSpan(maxLineSpan) }, key = "rodape") {
                        Box(Modifier.fillMaxWidth().height(60.dp), contentAlignment = Alignment.Center) {
                            Text(
                                text = "Carregando mais…",
                                color = Cores.TextoApagado,
                                fontSize = Escala.Rotulo,
                            )
                        }
                    }
                }
            }

            carregando -> Aviso("Carregando…")
            erro -> Aviso("Não foi possível carregar.", "Tentar de novo") { recarga++ }
            else -> Aviso("Nada encontrado com esses filtros.")
        }
    }
}

/**
 * Cabecalho da tela: destaque grande a esquerda, atalhos a direita.
 *
 * O destaque e o primeiro item da selecao corrente, entao ele muda junto com o
 * filtro — a tela responde ao que foi escolhido em vez de exibir sempre a mesma
 * capa. E um card focavel de verdade: OK abre a ficha.
 */
@Composable
private fun Cabecalho(
    aba: Aba,
    destaque: Item,
    ordem: Ordem,
    genero: Genero?,
    ano: Int?,
    generos: List<Genero>,
    anos: List<Int>,
    aoOrdem: (Ordem) -> Unit,
    aoGenero: (Genero?) -> Unit,
    aoAno: (Int?) -> Unit,
    aoFocarArte: (String?) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(bottom = 14.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().height(280.dp),
            horizontalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            CartazDestaque(
                item = destaque,
                modifier = Modifier.weight(1.35f).fillMaxHeight(),
                aoFocarArte = aoFocarArte,
            )

            Column(
                modifier = Modifier.weight(1f).fillMaxHeight(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Sobretitulo(aba.rotulo.lowercase().replaceFirstChar { it.uppercase() })

                GrupoFiltro(rotulo = "Ordenar") {
                    Ordem.values().forEach { opcao ->
                        Pilula(
                            texto = opcao.rotulo,
                            selecionado = opcao == ordem,
                            aoClicar = { aoOrdem(opcao) },
                        )
                    }
                }

                if (generos.isNotEmpty()) {
                    GrupoFiltro(rotulo = "Gênero") {
                        Pilula("Todos", selecionado = genero == null, aoClicar = { aoGenero(null) })
                        generos.forEach { g ->
                            Pilula(g.nome, selecionado = genero?.id == g.id, aoClicar = { aoGenero(g) })
                        }
                    }
                }

                if (anos.isNotEmpty()) {
                    GrupoFiltro(rotulo = "Ano") {
                        Pilula("Todos", selecionado = ano == null, aoClicar = { aoAno(null) })
                        anos.forEach { a ->
                            Pilula(a.toString(), selecionado = ano == a, aoClicar = { aoAno(a) })
                        }
                    }
                }
            }
        }
    }
}

/**
 * Uma linha de atalhos.
 *
 * Rola na horizontal porque a lista de generos nao cabe na largura reservada, e
 * quebrar em duas linhas empurraria a grade para fora da tela.
 */
@Composable
private fun GrupoFiltro(rotulo: String, conteudo: @Composable () -> Unit) {
    Column {
        Text(text = rotulo, color = Cores.TextoApagado, fontSize = Escala.Miudo)
        EspacoV(6.dp)
        Row(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier
                .horizontalScroll(rememberScrollState())
                .padding(vertical = 4.dp),
            content = { conteudo() },
        )
    }
}

@Composable
private fun CartazDestaque(
    item: Item,
    modifier: Modifier,
    aoFocarArte: (String?) -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.02f)
    val forma = RoundedCornerShape(14.dp)

    Box(
        modifier = modifier
            .escalar(escala)
            .clip(forma)
            .background(Cores.Superficie)
            .border(
                width = if (focado) 3.dp else 0.dp,
                color = if (focado) Cores.FocoHalo else Color.Transparent,
                shape = forma,
            )
            .focavel(
                interacao = interacao,
                aoFocar = { aoFocarArte(item.background) },
                aoClicar = { Navegacao.abrirDetalhe(item) },
            ),
    ) {
        ApiObaflix.imagem(item.background ?: item.poster, "w1280")?.let { url ->
            AsyncImage(
                model = url,
                contentDescription = item.titulo,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    0f to Color.Transparent,
                    0.5f to Color.Black.copy(alpha = 0.4f),
                    1f to Color.Black.copy(alpha = 0.92f),
                ),
            ),
        )
        Column(Modifier.align(Alignment.BottomStart).padding(22.dp)) {
            Text(
                text = item.titulo,
                color = Cores.Texto,
                fontSize = Escala.Titulo,
                fontWeight = FontWeight.Black,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            EspacoV(8.dp)
            LinhaMeta(
                ano = item.ano,
                nota = item.nota,
                generos = item.generos.map { it.nome },
                tipo = rotuloTipo(item.tipo),
            )
        }
    }
}
