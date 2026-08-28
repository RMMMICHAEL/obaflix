package com.obaflix.tv.ui

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Home
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.ui.componentes.EspacoH
import com.obaflix.tv.ui.componentes.EspacoV
import com.obaflix.tv.ui.componentes.FileiraCatalogo
import com.obaflix.tv.ui.componentes.LinhaMeta
import com.obaflix.tv.ui.componentes.escalaFoco
import com.obaflix.tv.ui.componentes.escalar
import com.obaflix.tv.ui.componentes.focavel
import kotlinx.coroutines.delay

/**
 * Home.
 *
 * Dois destaques grandes lado a lado e, abaixo, as fileiras reais do catalogo.
 * A ordem nao e estetica: Continuar Assistindo vem primeiro porque e o motivo
 * mais comum de alguem ligar a televisao, e os destaques ficam acima dela
 * porque sao o que da escala e cor a tela inteira.
 *
 * A carga e a mesma de antes — duas requisicoes —, entao a tela ficou muito
 * maior sem custar nada a mais na Vercel nem no Supabase.
 */
@Composable
fun ColumnScope.TelaHome(aoFocarArte: (String?) -> Unit) {
    var home by remember { mutableStateOf<Home?>(null) }
    var erro by remember { mutableStateOf(false) }
    var recarga by remember { mutableStateOf(0) }
    val rolagem = rememberLazyListState()
    val margem = margemHorizontal()

    LaunchedEffect(recarga) {
        erro = false
        val resultado = ApiObaflix.home()
        if (resultado == null) erro = true else home = resultado
    }

    val dados = home
    Box(Modifier.fillMaxWidth().weight(1f)) {
        when {
            dados != null -> LazyColumn(
                state = rolagem,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(top = 8.dp, bottom = margemVertical()),
                verticalArrangement = Arrangement.spacedBy(Medidas.EspacoFileiras),
            ) {
                if (dados.destaques.isNotEmpty()) {
                    item(key = "destaques") {
                        DestaqueDuplo(dados.destaques, margem, aoFocarArte)
                    }
                }
                items(dados.fileiras, key = { it.id }) { fileira ->
                    FileiraCatalogo(
                        fileira = fileira,
                        margem = margem,
                        aoFocar = { aoFocarArte(it.background) },
                        aoAbrir = { Navegacao.abrirDetalhe(it) },
                    )
                }
            }

            erro -> Aviso(
                texto = "Não foi possível carregar o catálogo.",
                acao = "Tentar de novo",
                aoAgir = { recarga++ },
            )

            else -> Aviso(texto = "Carregando o catálogo…")
        }
    }
}

/**
 * Os dois banners do topo.
 *
 * Cada um roda a sua propria sequencia — o da esquerda pelos indices pares, o
 * da direita pelos impares — para nunca mostrarem o mesmo titulo ao mesmo
 * tempo. Quando um deles esta focado, ele para de trocar: mudar o conteudo sob
 * o cursor faria a pessoa abrir algo diferente do que estava olhando.
 */
@Composable
private fun DestaqueDuplo(
    itens: List<Item>,
    margem: androidx.compose.ui.unit.Dp,
    aoFocarArte: (String?) -> Unit,
) {
    val pares = itens.filterIndexed { i, _ -> i % 2 == 0 }
    val impares = itens.filterIndexed { i, _ -> i % 2 == 1 }

    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = margem),
        horizontalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        BannerDestaque(pares, Modifier.weight(1f), aoFocarArte)
        if (impares.isNotEmpty()) {
            BannerDestaque(impares, Modifier.weight(1f), aoFocarArte)
        }
    }
}

@Composable
private fun BannerDestaque(
    itens: List<Item>,
    modifier: Modifier,
    aoFocarArte: (String?) -> Unit,
) {
    if (itens.isEmpty()) return

    var indice by remember(itens) { mutableStateOf(0) }
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.02f)
    val item = itens[indice.coerceIn(itens.indices)]
    val forma = RoundedCornerShape(14.dp)

    LaunchedEffect(itens, focado) {
        if (focado || itens.size < 2) return@LaunchedEffect
        while (true) {
            delay(9000)
            indice = (indice + 1) % itens.size
        }
    }

    LaunchedEffect(focado, item.id) {
        if (focado) aoFocarArte(item.background)
    }

    Box(
        modifier = modifier
            .height(320.dp)
            .escalar(escala)
            .clip(forma)
            .background(Cores.Superficie)
            .border(
                width = if (focado) 3.dp else 0.dp,
                color = if (focado) Cores.FocoHalo else Color.Transparent,
                shape = forma,
            )
            .focavel(interacao = interacao) { Navegacao.abrirDetalhe(item) },
    ) {
        // Fusao entre um destaque e o proximo: corte seco em imagem desse
        // tamanho e percebido como falha de renderizacao, nao como troca.
        Crossfade(targetState = item, animationSpec = tween(600), label = "banner") { atual ->
            Box(Modifier.fillMaxSize()) {
                ApiObaflix.imagem(atual.background, "w1280")?.let { url ->
                    AsyncImage(
                        model = url,
                        contentDescription = atual.titulo,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                Box(
                    Modifier.fillMaxSize().background(
                        Brush.verticalGradient(
                            0f to Color.Transparent,
                            0.45f to Color.Black.copy(alpha = 0.35f),
                            1f to Color.Black.copy(alpha = 0.92f),
                        ),
                    ),
                )
                Column(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(24.dp)
                        .fillMaxWidth(0.8f),
                ) {
                    // Quando o catalogo tem o logo do titulo, ele vale mais que
                    // qualquer tipografia nossa: e a marca que a pessoa
                    // reconhece de longe.
                    val logo = ApiObaflix.imagem(atual.logo, "w500")
                    if (logo != null) {
                        AsyncImage(
                            model = logo,
                            contentDescription = atual.titulo,
                            contentScale = ContentScale.Fit,
                            alignment = Alignment.BottomStart,
                            modifier = Modifier.fillMaxWidth(0.66f).height(74.dp),
                        )
                    } else {
                        Text(
                            text = atual.titulo,
                            color = Cores.Texto,
                            fontSize = Escala.Titulo,
                            fontWeight = FontWeight.Black,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    EspacoV(10.dp)
                    LinhaMeta(
                        ano = atual.ano,
                        nota = atual.nota,
                        generos = atual.generos.map { it.nome },
                        tipo = rotuloTipo(atual.tipo),
                    )
                }
            }
        }

        if (itens.size > 1) {
            Row(
                modifier = Modifier.align(Alignment.BottomEnd).padding(20.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                itens.forEachIndexed { i, _ ->
                    Box(
                        Modifier
                            .size(width = if (i == indice) 20.dp else 8.dp, height = 6.dp)
                            .clip(RoundedCornerShape(3.dp))
                            .background(if (i == indice) Cores.Destaque else Color.White.copy(alpha = 0.4f)),
                    )
                }
            }
        }
    }
}

/** Nome que o usuario comum le para cada tipo do catalogo. */
fun rotuloTipo(tipo: String): String = when (tipo) {
    "filme" -> "Filme"
    "anime" -> "Anime"
    "desenho" -> "Kids"
    else -> "Série"
}

/**
 * Estado vazio, de carga e de erro.
 *
 * Um so componente para os tres: em televisao a diferenca entre "carregando" e
 * "deu errado" tem de ser o texto, nunca o layout — a tela mudar de forma no
 * meio da espera parece defeito.
 */
@Composable
fun Aviso(texto: String, acao: String? = null, aoAgir: (() -> Unit)? = null) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(text = texto, color = Cores.TextoFraco, fontSize = Escala.Corpo)
            if (acao != null && aoAgir != null) {
                EspacoV(20.dp)
                com.obaflix.tv.ui.componentes.Pilula(texto = acao, principal = true, aoClicar = aoAgir)
            }
        }
    }
}

/** Rotulo curto com folga, usado nos cabecalhos das telas de catalogo. */
@Composable
fun Sobretitulo(texto: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(width = 4.dp, height = 22.dp).background(Cores.Destaque))
        EspacoH(10.dp)
        Text(
            text = texto,
            color = Cores.Texto,
            fontSize = Escala.Secao,
            fontWeight = FontWeight.Black,
        )
    }
}
