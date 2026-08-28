package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
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
import com.obaflix.tv.catalogo.Item

/**
 * Detalhe de um título.
 *
 * Concentra tudo numa tela: informação, botão de assistir, temporada e
 * episódios. A alternativa — uma tela para episódios, outra para temporada — é
 * o que faz o usuário de TV desistir, porque cada tela nova custa uma volta com
 * o controle e uma nova busca por onde está o foco.
 *
 * Trocar de temporada não vai ao servidor: os episódios da série inteira vêm
 * numa chamada só e o filtro acontece aqui. Menos invocação, e a troca é
 * instantânea para quem está apertando o botão.
 */
@Composable
fun TelaDetalhe(
    id: String,
    tipo: String,
    aoReproduzir: (Rota.Player) -> Unit,
    aoAbrirRelacionado: (Item) -> Unit,
) {
    var detalhe by remember(id) { mutableStateOf<ApiObaflix.Detalhe?>(null) }
    var episodios by remember(id) { mutableStateOf<List<ApiObaflix.Episodio>>(emptyList()) }
    var temporada by remember(id) { mutableStateOf<Int?>(null) }
    var erro by remember(id) { mutableStateOf(false) }
    val focoPrincipal = focoInicial()

    val ehSerie = tipo != "filme"

    LaunchedEffect(id, tipo) {
        val d = ApiObaflix.detalhe(id, tipo)
        if (d == null) {
            erro = true
            return@LaunchedEffect
        }
        detalhe = d
        if (ehSerie) {
            val eps = ApiObaflix.episodios(id)
            episodios = eps
            temporada = eps.minOfOrNull { it.temporada } ?: 1
        }
    }

    val dados = detalhe
    if (erro) {
        MensagemCentral("Não foi possível abrir este título.")
        return
    }
    if (dados == null) {
        MensagemCentral("Carregando…")
        return
    }

    val item = dados.item
    val temporadas = remember(episodios) { episodios.map { it.temporada }.distinct().sorted() }
    val daTemporada = remember(episodios, temporada) {
        episodios.filter { it.temporada == temporada }
    }
    val margem = margemSegura()

    Box(Modifier.fillMaxSize()) {
        // Arte de fundo cobrindo a tela, com véu por cima. Sem o véu, sinopse
        // sobre cena clara fica ilegível — e não dá para escolher a cena.
        ApiObaflix.imagem(item.background ?: item.poster, "w1280")?.let { url ->
            AsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(
                    listOf(Cores.Fundo.copy(alpha = 0.82f), Cores.Fundo.copy(alpha = 0.97f)),
                ),
            ),
        )

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = margem.calculateLeftPadding(LayoutDirection.Ltr),
                top = margem.calculateTopPadding(),
                bottom = margem.calculateBottomPadding(),
            ),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            item {
                Column(modifier = Modifier.fillMaxWidth(0.62f)) {
                    Text(
                        text = item.titulo,
                        color = Cores.Texto,
                        fontSize = Escala.Titulo,
                        fontWeight = FontWeight.Bold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )

                    Box(Modifier.height(10.dp))

                    // Linha de fatos: só o que ajuda a decidir se vale assistir.
                    val fatos = buildList {
                        item.ano?.let { add(it.toString()) }
                        item.nota?.let { add("★ %.1f".format(it)) }
                        if (ehSerie && temporadas.isNotEmpty()) {
                            add("${temporadas.size} temporada${if (temporadas.size == 1) "" else "s"}")
                        }
                        addAll(dados.generos.take(3))
                    }
                    if (fatos.isNotEmpty()) {
                        Text(
                            text = fatos.joinToString("  ·  "),
                            color = Cores.TextoFraco,
                            fontSize = Escala.Rotulo,
                        )
                    }

                    item.sinopse?.let {
                        Box(Modifier.height(14.dp))
                        Text(
                            text = it,
                            color = Cores.TextoFraco,
                            fontSize = Escala.Corpo,
                            maxLines = 4,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }

                    Box(Modifier.height(22.dp))

                    Row(
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                        modifier = Modifier.focusGroup(),
                    ) {
                        val primeiro = daTemporada.firstOrNull()
                        BotaoTv(
                            texto = if (ehSerie) "Assistir T${primeiro?.temporada ?: 1}:E${primeiro?.numeroEp ?: 1}" else "Assistir",
                            destaque = true,
                            modifier = Modifier.focusRequester(focoPrincipal),
                        ) {
                            aoReproduzir(
                                Rota.Player(
                                    conteudoId = id,
                                    tipo = tipo,
                                    titulo = item.titulo,
                                    temporada = primeiro?.temporada,
                                    numeroEp = primeiro?.numeroEp,
                                    episodioId = primeiro?.id,
                                ),
                            )
                        }
                    }
                }
            }

            // ── Temporadas ───────────────────────────────────────────────────
            if (ehSerie && temporadas.size > 1) {
                item {
                    Column {
                        Text(
                            text = "Temporadas",
                            color = Cores.Texto,
                            fontSize = Escala.Secao,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(bottom = 10.dp),
                        )
                        LazyRow(
                            modifier = Modifier.focusGroup(),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            contentPadding = PaddingValues(end = 64.dp),
                        ) {
                            items(temporadas, key = { it }) { numero ->
                                BotaoTv(
                                    texto = "Temporada $numero",
                                    destaque = numero == temporada,
                                ) { temporada = numero }
                            }
                        }
                    }
                }
            }

            // ── Episódios ────────────────────────────────────────────────────
            if (ehSerie && daTemporada.isNotEmpty()) {
                item {
                    Column {
                        Text(
                            text = "Episódios",
                            color = Cores.Texto,
                            fontSize = Escala.Secao,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.padding(bottom = 12.dp),
                        )
                        LazyRow(
                            modifier = Modifier.focusGroup(),
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                            contentPadding = PaddingValues(end = 64.dp),
                        ) {
                            items(daTemporada, key = { it.id }) { ep ->
                                CardEpisodio(ep, item) {
                                    aoReproduzir(
                                        Rota.Player(
                                            conteudoId = id,
                                            tipo = tipo,
                                            titulo = item.titulo,
                                            temporada = ep.temporada,
                                            numeroEp = ep.numeroEp,
                                            episodioId = ep.id,
                                        ),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CardEpisodio(
    ep: ApiObaflix.Episodio,
    serie: Item,
    aoAcionar: () -> Unit,
) {
    // Reaproveita o card de conteúdo: mesmo foco, mesma escala, mesma barra.
    // Um episódio é conteúdo como outro qualquer; inventar um segundo estilo de
    // foco só faria a tela parecer feita por duas pessoas diferentes.
    CardConteudo(
        item = Item(
            id = ep.id,
            titulo = ep.titulo ?: "Episódio ${ep.numeroEp}",
            poster = null,
            background = ep.thumbnail ?: serie.background,
            logo = null,
            sinopse = ep.sinopse,
            ano = null,
            nota = null,
            tipo = "episodio",
            temporada = ep.temporada,
            numeroEp = ep.numeroEp,
        ),
        paisagem = true,
        aoAbrir = { aoAcionar() },
    )
}
