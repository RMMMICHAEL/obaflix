package com.obaflix.tv.ui

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.focusGroup
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.CacheTelas
import com.obaflix.tv.catalogo.Genero
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.navegacao.Aba
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.ui.componentes.CardPoster
import com.obaflix.tv.ui.componentes.colunas
import com.obaflix.tv.ui.componentes.Pilula
import com.obaflix.tv.ui.componentes.EfeitoRestauraFoco
import com.obaflix.tv.ui.componentes.enderecoDe
import com.obaflix.tv.ui.componentes.escalaFoco
import com.obaflix.tv.ui.componentes.escalar
import com.obaflix.tv.ui.componentes.focavel

/**
 * Ordens que a rota de catalogo aceita. Sao exatamente as do backend.
 */
private enum class Ordem(val rotulo: String, val chave: String) {
    Recentes("Recentes", "recente"),
    Populares("Populares", "popular"),
    Lancamentos("Lançamentos", "lancamento"),
    Nota("Melhor nota", "nota"),
    Az("A–Z", "az"),
}

/**
 * Tela de catalogo — Filmes, Séries, Animes e Kids.
 *
 * Reproduz o activity_vodcategory da referencia: **barra lateral** a esquerda
 * (Buscar, Ordenar, e a lista de generos) e uma **grade de 6 colunas** a
 * direita, com titulo e contagem no topo. Nao ha mais painel grande e vazio: o
 * catalogo ocupa a tela.
 *
 * As quatro abas compartilham esta tela porque, no backend, sao a mesma
 * consulta com um `tipo` diferente. Os generos saem da primeira pagina — nenhum
 * atalho promete uma categoria que o catalogo nao tem, e nao foi preciso criar
 * rota nova para descobrir isso.
 */
@Composable
fun ColumnScope.TelaCatalogo(aba: Aba, aoFocarArte: (String?) -> Unit) {
    val tipo = when (aba) {
        Aba.Series -> "serie"
        Aba.Animes -> "anime"
        Aba.Kids -> "desenho"
        else -> null
    }

    // Estado inicial vem do cache: voltar de uma ficha nao refaz a consulta nem
    // perde o filtro; a grade reaparece como estava e o foco volta ao card.
    val cache = remember(aba) { CacheTelas.catalogo(aba.name) }

    var ordem by remember(aba) { mutableStateOf(Ordem.values().getOrElse(cache.ordemOrdinal) { Ordem.Populares }) }
    var genero by remember(aba) { mutableStateOf(cache.generos.find { it.id == cache.generoId }) }
    var ano by remember(aba) { mutableStateOf(cache.anoSel) }

    var itens by remember(aba) { mutableStateOf(cache.itens) }
    var total by remember(aba) { mutableStateOf(cache.itens.size) }
    var pagina by remember(aba) { mutableStateOf(cache.pagina) }
    var paginas by remember(aba) { mutableStateOf(cache.paginas) }
    var carregando by remember(aba) { mutableStateOf(cache.vazio) }
    var erro by remember(aba) { mutableStateOf(false) }
    var recarga by remember(aba) { mutableStateOf(0) }
    var inicializado by remember(aba) { mutableStateOf(false) }

    var generosConhecidos by remember(aba) { mutableStateOf(cache.generos) }

    val grade = rememberLazyGridState()
    val conteinerFoco = remember { FocusRequester() }
    var temFoco by remember(aba) { mutableStateOf(false) }
    val focoMoldura = com.obaflix.tv.ui.componentes.LocalFocoMoldura.current
    // Trocar de aba faz dados chegarem, e era isso que puxava o cursor para
    // o primeiro card. Com a barra em foco, a grade espera o DOWN.
    EfeitoRestauraFoco(
        pronto = itens.isNotEmpty(),
        primeiro = conteinerFoco,
        temFoco = { temFoco },
        tag = "Cat-" + aba.name,
        permitido = { !focoMoldura.barraComFoco },
    )
    val margem = margemHorizontal()
    val larguraGrade = larguraTelaDp() - Medidas.RailLargura.value.toInt() - margem.value.toInt() - 24
    val nColunas = colunas(larguraGrade)

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
        // Dedupe no append: a pagina 2 pode trazer um item que ja veio na 1
        // (popularidade muda entre as consultas), e a grade quebraria com key
        // repetida. distinctBy protege sem esconder erro nenhum.
        itens = if (paginaAlvo == 1) resposta.itens else (itens + resposta.itens).distinctBy { it.id }
        pagina = resposta.pagina
        paginas = resposta.paginas
        total = maxOf(total, itens.size)
        erro = false
        carregando = false

        if (generosConhecidos.isEmpty()) {
            generosConhecidos = resposta.itens.flatMap { it.generos }
                .distinctBy { it.id }
                .sortedBy { it.nome }
                        .take(24)
        }

        // Espelha no cache para o retorno ser instantaneo.
        cache.itens = itens
        cache.pagina = pagina
        cache.paginas = paginas
        cache.ordemOrdinal = ordem.ordinal
        cache.generoId = genero?.id
        cache.anoSel = ano
        cache.generos = generosConhecidos
    }

    LaunchedEffect(aba, ordem, genero, ano, recarga) {
        // Primeira composicao com cache cheio: nao busca, so aproveita. A
        // rolagem volta pelo estado saveable da grade.
        if (!inicializado && !cache.vazio && recarga == 0) {
            inicializado = true
            return@LaunchedEffect
        }
        inicializado = true
        carregando = true
        itens = emptyList()
        total = 0
        carregar(1)
        runCatching { grade.scrollToItem(0) }
    }

    val precisaMais by remember {
        derivedStateOf {
            val ultimo = grade.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            ultimo >= itens.size - nColunas * 2
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

    Row(Modifier.fillMaxWidth().weight(1f)) {
        // ── Barra lateral ────────────────────────────────────────────────────
        Rail(
            aba = aba,
            ordem = ordem,
            genero = genero,
            generos = generosConhecidos,
            aoBuscar = { Navegacao.irPara(Aba.Busca) },
            aoOrdem = { ordem = Ordem.values()[(ordem.ordinal + 1) % Ordem.values().size] },
            aoGenero = { genero = it },
        )

        // ── Grade ────────────────────────────────────────────────────────────
        Box(Modifier.weight(1f).fillMaxHeight()) {
            Column(Modifier.fillMaxSize()) {
                CabecalhoCatalogo(
                    titulo = aba.rotulo.lowercase().replaceFirstChar { it.uppercase() },
                    genero = genero?.nome,
                    ordem = ordem.rotulo,
                    total = if (itens.isNotEmpty()) itens.size else null,
                    pagina = pagina,
                    paginas = paginas,
                )
                FiltroAno(ano = ano, aoAno = { ano = it })
                when {
                    itens.isNotEmpty() -> LazyVerticalGrid(
                        columns = GridCells.Fixed(nColunas),
                        state = grade,
                        modifier = Modifier
                            .fillMaxSize()
                            .focusRequester(conteinerFoco)
                            .focusGroup()
                            .onFocusChanged { temFoco = it.hasFocus },
                        contentPadding = PaddingValues(
                            start = 20.dp, end = margem, top = 6.dp, bottom = margemVertical(),
                        ),
                        horizontalArrangement = Arrangement.spacedBy(Medidas.EspacoCards),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        itemsIndexed(itens, key = { _, item -> item.id }) { indice, item ->
                            CardPoster(
                                item = item,
                                chaveFoco = enderecoDe("grade-" + aba.name, indice),
                                aoFocar = { aoFocarArte(it.background) },
                                // So a primeira fileira sobe para a barra, e sobe
                                // para a opcao da aba aberta — nao para a que
                                // calhar de estar acima na geometria. Nas demais
                                // fileiras a seta para cima continua andando
                                // dentro da grade, como se espera.
                                modifier = if (indice < nColunas) {
                                    Modifier.focusProperties { up = focoMoldura.requisitorAtivo }
                                } else {
                                    Modifier
                                },
                                aoAbrir = { Navegacao.abrirDetalhe(it) },
                            )
                        }
                    }

                    carregando -> Aviso("Carregando…")
                    erro -> Aviso("Não foi possível carregar.", "Tentar de novo") { recarga++ }
                    else -> Aviso("Nada encontrado.")
                }
            }
        }
    }
}

/** Mesma espera das abas: aplica ao parar, nao ao atravessar. */
private const val ATRASO_FILTRO_MS = 280L

/**
 * Barra lateral: Buscar, Ordenar e a lista de generos.
 *
 * Espelha a coluna esquerda do activity_vodcategory (320px -> 168dp). Selecionar
 * um genero recarrega a grade na hora; "Ordenar" cicla entre as ordens que o
 * backend aceita, mostrando a atual.
 */
@Composable
private fun Rail(
    aba: Aba,
    ordem: Ordem,
    genero: Genero?,
    generos: List<Genero>,
    aoBuscar: () -> Unit,
    aoOrdem: () -> Unit,
    aoGenero: (Genero?) -> Unit,
) {
    LazyColumn(
        modifier = Modifier
            .width(Medidas.RailLargura)
            .fillMaxHeight()
            .background(Cores.Painel.copy(alpha = 0.6f)),
        contentPadding = PaddingValues(top = 16.dp, bottom = margemVertical()),
    ) {
        item { RailItem("Buscar", destaque = true, aoClicar = aoBuscar) }
        item { RailItem("Ordenar: " + ordem.rotulo, destaque = true, aoClicar = aoOrdem) }
        item {
            Box(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 8.dp)
                    .height(1.dp)
                    .background(Color.White.copy(alpha = 0.12f)),
            )
        }
        item {
            RailItem(
                "Todos",
                selecionado = genero == null,
                aplicaNoFoco = true,
                aoClicar = { aoGenero(null) },
            )
        }
        items(generos, key = { it.id }) { g ->
            RailItem(
                g.nome,
                selecionado = genero?.id == g.id,
                aplicaNoFoco = true,
                aoClicar = { aoGenero(g) },
            )
        }
    }
}

@Composable
private fun RailItem(
    texto: String,
    selecionado: Boolean = false,
    destaque: Boolean = false,
    /**
     * Se o item se aplica so por receber foco.
     *
     * Vale para filtro — genero, ano, categoria: mover a seta ate "Ação" ja
     * mostra ação. Nao vale para "Buscar" e "Ordenar", que sao acoes: trocar a
     * ordenacao porque a seta passou por cima seria hostil.
     */
    aplicaNoFoco: Boolean = false,
    aoClicar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()

    // Espera antes de aplicar; o cancelamento vem do proprio LaunchedEffect,
    // que morre quando o foco sai. Descer a lista inteira de generos nao gera
    // uma consulta por genero — so o que ficou sob a seta chega a carregar.
    LaunchedEffect(focado) {
        if (!aplicaNoFoco || !focado || selecionado) return@LaunchedEffect
        kotlinx.coroutines.delay(ATRASO_FILTRO_MS)
        aoClicar()
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp)
            .background(if (focado) Cores.Destaque else Color.Transparent)
            .focavel(interacao = interacao, aoClicar = aoClicar)
            .padding(horizontal = 20.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        // Marca vermelha do item selecionado, quando o foco esta noutro lugar.
        if (selecionado && !focado) {
            Box(Modifier.width(4.dp).height(20.dp).clip(RoundedCornerShape(2.dp)).background(Cores.Destaque))
        }
        Text(
            text = texto,
            color = when {
                focado -> Cores.Texto
                selecionado -> Cores.Texto
                destaque -> Cores.TextoFraco
                else -> Cores.TextoFraco
            },
            fontSize = Escala.Rotulo,
            fontWeight = if (selecionado || focado || destaque) FontWeight.Bold else FontWeight.Normal,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = if (selecionado && !focado) 10.dp else 0.dp),
        )
    }
}

/**
 * Filtro de ano.
 *
 * Os anos sao gerados de 2010 ate o ano atual (java.time.Year.now), entao no
 * ano que vem aparece 2027 sozinho, sem tocar no codigo. "Todos" limpa o filtro.
 */
@Composable
private fun FiltroAno(ano: Int?, aoAno: (Int?) -> Unit) {
    val anos = remember {
        // Calendar, e nao java.time.Year: aquele so existe da API 26, e o
        // aplicativo alcanca a 21 para cobrir TV Box com Android 5 e 6 — onde
        // isto estouraria NoSuchMethodError ao abrir o filtro.
        val atual = java.util.Calendar.getInstance().get(java.util.Calendar.YEAR)
        (atual downTo 2010).toList()
    }
    androidx.compose.foundation.lazy.LazyRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(start = 20.dp, end = margemHorizontal(), top = 4.dp, bottom = 6.dp),
        modifier = Modifier.focusGroup(),
    ) {
        item {
            Pilula(
                "Ano: todos",
                selecionado = ano == null,
                aplicaNoFoco = true,
                aoClicar = { aoAno(null) },
            )
        }
        items(anos) { a ->
            Pilula(a.toString(), selecionado = ano == a, aplicaNoFoco = true, aoClicar = { aoAno(a) })
        }
    }
}

@Composable
private fun CabecalhoCatalogo(
    titulo: String,
    genero: String?,
    ordem: String,
    total: Int?,
    pagina: Int,
    paginas: Int,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = margemHorizontal(), top = 14.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = genero?.let { titulo + " · " + it } ?: titulo,
            color = Cores.Texto,
            fontSize = Escala.Secao,
            fontWeight = FontWeight.Black,
        )
        if (total != null) {
            com.obaflix.tv.ui.componentes.EspacoH(12.dp)
            Text(text = total.toString() + "+", color = Cores.Nota, fontSize = Escala.Rotulo, fontWeight = FontWeight.Bold)
        }
        Box(Modifier.weight(1f))
        Text(text = ordem, color = Cores.TextoApagado, fontSize = Escala.Miudo)
        if (paginas > 1) {
            com.obaflix.tv.ui.componentes.EspacoH(16.dp)
            Text(text = pagina.toString() + " / " + paginas, color = Cores.TextoApagado, fontSize = Escala.Miudo)
        }
    }
}
