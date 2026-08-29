package com.obaflix.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.CacheTelas
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.sessao.PareamentoTv
import com.obaflix.tv.ui.componentes.CardPaisagem
import com.obaflix.tv.ui.componentes.CardPoster
import com.obaflix.tv.ui.componentes.EspacoH
import com.obaflix.tv.ui.componentes.EspacoV
import com.obaflix.tv.ui.componentes.Pilula
import com.obaflix.tv.ui.componentes.enderecoDe
import kotlinx.coroutines.launch

/**
 * Perfil.
 *
 * Reune o que ja existe no backend do Obaflix — Continuar Assistindo, Favoritos
 * e Historico — numa area so, com remocao item a item. Nao ha banco novo nem
 * logica duplicada: cada lista vem do seu endpoint e cada "Remover" chama o
 * DELETE que o site ja usa. Ao remover, o cache da Home e invalidado para a
 * fileira "Continuar assistindo" refletir na hora.
 *
 * Dados de conta: a TV recebe so o aparelho (a sessao nao devolve nome nem
 * e-mail, por privacidade), entao o cabecalho mostra o dispositivo. Nada e
 * inventado alem disso.
 */
/**
 * Como os favoritos sao agrupados.
 *
 * Segue as abas do aplicativo, para a pessoa reconhecer o mesmo vocabulario nos
 * dois lugares. "Kids" agrupa desenho, que e como o catalogo classifica.
 */
private val CATEGORIAS_FAVORITO: List<Pair<String, Set<String>>> = listOf(
    "Filmes" to setOf("filme"),
    "Séries" to setOf("serie"),
    "Animes" to setOf("anime"),
    "Kids" to setOf("desenho", "kids"),
)

@Composable
fun TelaPerfil() {
    val context = LocalContext.current
    val escopo = rememberCoroutineScope()

    var continuar by remember { mutableStateOf<List<Item>>(emptyList()) }
    var favoritos by remember { mutableStateOf<List<Item>>(emptyList()) }
    var historico by remember { mutableStateOf<List<Item>>(emptyList()) }
    var carregando by remember { mutableStateOf(true) }
    var recarga by remember { mutableStateOf(0) }

    val primeiro = remember { FocusRequester() }

    LaunchedEffect(recarga) {
        continuar = ApiObaflix.continuarAssistindo().orEmpty()
        favoritos = ApiObaflix.favoritos()
        historico = ApiObaflix.historico()
        carregando = false
    }

    LaunchedEffect(carregando) {
        if (!carregando) {
            repeat(10) {
                runCatching { primeiro.requestFocus() }
                kotlinx.coroutines.delay(60)
            }
        }
    }

    BackHandler(enabled = true) { Navegacao.voltar() }

    fun aposRemover() {
        // Continuar Assistindo aparece na Home; invalidar o cache faz a Home
        // recarregar sem o item removido na proxima vez que for aberta.
        CacheTelas.home = null
        recarga++
    }

    val margem = margemHorizontal()

    Box(Modifier.fillMaxSize().background(Cores.Fundo)) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(top = margemVertical(), bottom = 24.dp),
        ) {
            // ── Cabecalho ─────────────────────────────────────────────────────
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = margem),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Perfil", color = Cores.Texto, fontSize = Escala.Titulo, fontWeight = FontWeight.Black)
                    EspacoV(4.dp)
                    Text(
                        text = "Aparelho: " + PareamentoTv.modelo(),
                        color = Cores.TextoFraco,
                        fontSize = Escala.Rotulo,
                    )
                }
                // Voltar visivel e alcancavel pelo controle. O BACK continua
                // funcionando, mas depender so dele obriga a pessoa a saber que
                // ele existe — e nem todo controle de TV Box tem tecla obvia.
                Pilula(
                    texto = "Voltar",
                    modifier = Modifier.focusRequester(primeiro),
                    aoClicar = { Navegacao.voltar() },
                )
                EspacoH(12.dp)
                Pilula(
                    texto = "Sair da conta",
                    aoClicar = { escopo.launch { PareamentoTv.sair(context) } },
                )
            }

            EspacoV(24.dp)

            when {
                carregando -> Text(
                    "Carregando…",
                    color = Cores.TextoFraco,
                    fontSize = Escala.Corpo,
                    modifier = Modifier.padding(horizontal = margem),
                )
                else -> {
                    Secao(
                        titulo = "Continuar Assistindo",
                        itens = continuar,
                        margem = margem,
                        paisagem = true,
                        rotuloRemover = "Remover",
                        aoRemover = { item ->
                            item.historyId?.let { hid ->
                                escopo.launch { ApiObaflix.removerHistorico(hid); aposRemover() }
                            }
                        },
                    )
                    // Favoritos por categoria. Uma lista unica com filme, serie,
                    // anime e desenho misturados vira uma fileira longa demais
                    // para percorrer com seta — separar e o que a torna usavel.
                    // So aparece a categoria que tem conteudo.
                    CATEGORIAS_FAVORITO.forEach { (rotulo, tipos) ->
                        val doGrupo = favoritos.filter { it.tipo in tipos }
                        if (doGrupo.isNotEmpty()) {
                            Secao(
                                titulo = "Favoritos · " + rotulo,
                                itens = doGrupo,
                                margem = margem,
                                paisagem = false,
                                rotuloRemover = "Remover",
                                aoRemover = { item ->
                                    escopo.launch {
                                        ApiObaflix.removerFavorito(item.id, item.tipo)
                                        aposRemover()
                                    }
                                },
                            )
                        }
                    }
                    Secao(
                        titulo = "Histórico",
                        itens = historico,
                        margem = margem,
                        paisagem = false,
                        rotuloRemover = "Remover",
                        aoRemover = { item ->
                            item.historyId?.let { hid ->
                                escopo.launch { ApiObaflix.removerHistorico(hid); aposRemover() }
                            }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun Secao(
    titulo: String,
    itens: List<Item>,
    margem: androidx.compose.ui.unit.Dp,
    paisagem: Boolean,
    rotuloRemover: String,
    aoRemover: (Item) -> Unit,
) {
    Column(Modifier.padding(bottom = 22.dp)) {
        Text(
            text = titulo,
            color = Cores.Texto,
            fontSize = Escala.Secao,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = margem, bottom = 8.dp),
        )
        if (itens.isEmpty()) {
            Text(
                text = "Nada por aqui ainda.",
                color = Cores.TextoApagado,
                fontSize = Escala.Rotulo,
                modifier = Modifier.padding(start = margem),
            )
            return@Column
        }
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(Medidas.EspacoCards),
            contentPadding = PaddingValues(start = margem, end = margem, top = 4.dp, bottom = 10.dp),
            modifier = Modifier.focusGroup(),
        ) {
            itemsIndexed(itens, key = { _, it -> titulo + (it.historyId ?: it.id) }) { indice, item ->
                Column(
                    modifier = Modifier.width(if (paisagem) Medidas.PaisagemLargura else Medidas.PosterLargura),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    if (paisagem) {
                        CardPaisagem(item, enderecoDe("perf-" + titulo, indice), aoAbrir = { Navegacao.abrirDetalhe(it) })
                    } else {
                        CardPoster(item, enderecoDe("perf-" + titulo, indice), aoAbrir = { Navegacao.abrirDetalhe(it) })
                    }
                    EspacoV(6.dp)
                    // O botao de remover fica logo abaixo do card: DOWN chega
                    // nele, OK remove. Fica claro e nao rouba o clique de abrir.
                    Pilula(texto = rotuloRemover, aoClicar = { aoRemover(item) })
                }
            }
        }
    }
}
