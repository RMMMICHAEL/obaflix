package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Fileira
import com.obaflix.tv.catalogo.Home
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.sessao.PareamentoTv
import kotlinx.coroutines.launch

/**
 * Home da TV.
 *
 * Destaque no topo e fileiras horizontais abaixo — a forma que todo mundo ja
 * conhece de televisao, e que funciona bem com quatro setas e um OK.
 *
 * O foco e o unico ponteiro que existe aqui, entao ele precisa ser inequivoco a
 * tres metros: o card cresce, ganha borda clara e o titulo aparece. Um sinal so
 * nao se enxerga de longe.
 */
@Composable
fun TelaHome(aoSair: () -> Unit) {
    val context = LocalContext.current
    val escopo = rememberCoroutineScope()
    var home by remember { mutableStateOf<Home?>(null) }
    var erro by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        val resultado = ApiObaflix.home()
        if (resultado == null) erro = true else home = resultado
    }

    Box(modifier = Modifier.fillMaxSize().background(Cores.Fundo)) {
        val dados = home
        when {
            erro -> MensagemCentral("Não foi possível carregar o catálogo.")
            dados == null -> MensagemCentral("Carregando…")
            else -> Conteudo(
                home = dados,
                aoSair = { escopo.launch { PareamentoTv.sair(context); aoSair() } },
            )
        }
    }
}

@Composable
private fun MensagemCentral(texto: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(text = texto, color = Cores.TextoFraco, fontSize = Escala.Corpo)
    }
}

@Composable
private fun Conteudo(home: Home, aoSair: () -> Unit) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = margemSegura(),
        verticalArrangement = Arrangement.spacedBy(28.dp),
    ) {
        item { Destaque(home.destaque, aoSair) }
        items(home.fileiras, key = { it.titulo }) { fileira -> FileiraHorizontal(fileira) }
    }
}

/**
 * Faixa de destaque.
 *
 * A arte sangra para fora da margem segura de proposito — imagem pode encostar
 * na borda, texto nao. O degrade existe para o titulo continuar legivel sobre
 * qualquer cena, clara ou escura.
 */
@Composable
private fun Destaque(item: Item?, aoSair: () -> Unit) {
    Box(modifier = Modifier.fillMaxWidth().height(340.dp)) {
        ApiObaflix.imagem(item?.background, "w1280")?.let { url ->
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
                            listOf(Cores.Fundo, Cores.Fundo.copy(alpha = 0.75f), Color.Transparent),
                        ),
                    ),
            )
        }

        Column(
            modifier = Modifier.fillMaxHeight().fillMaxWidth(0.55f).padding(32.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = item?.titulo ?: "Obaflix",
                color = Cores.Texto,
                fontSize = Escala.Titulo,
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            item?.sinopse?.let {
                Box(Modifier.height(12.dp))
                Text(
                    text = it,
                    color = Cores.TextoFraco,
                    fontSize = Escala.Corpo,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Box(Modifier.height(20.dp))
            // Sair fica no destaque, e nao escondido: enquanto nao existe tela de
            // conta, e o unico caminho para trocar de usuario na televisao.
            Button(onClick = aoSair) {
                Text(text = "Sair da conta", fontSize = Escala.Rotulo)
            }
        }
    }
}

@Composable
private fun FileiraHorizontal(fileira: Fileira) {
    Column {
        Text(
            text = fileira.titulo,
            color = Cores.Texto,
            fontSize = Escala.Secao,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(bottom = 12.dp),
        )
        LazyRow(
            // focusGroup: sem ele a travessia de foco atravessa a fileira item
            // a item e pode alcancar um no que a lista ja reciclou. E dai que
            // vem o "LayoutCoordinate operations are only valid when isAttached
            // is true" — o foco chega num no que nao existe mais.
            modifier = Modifier.focusGroup(),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            // Folga a direita para o ultimo card nao colar na borda da tela.
            contentPadding = androidx.compose.foundation.layout.PaddingValues(end = 48.dp),
        ) {
            // Chave estavel: sem ela a identidade do no muda a cada recomposicao
            // e o foco fica apontando para o item errado — ou para nenhum.
            items(fileira.itens, key = { it.id }) { item -> Card(item, fileira.paisagem) }
        }
    }
}

@Composable
private fun Card(item: Item, paisagem: Boolean) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()

    Column(modifier = Modifier.width(if (paisagem) 300.dp else 170.dp)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(if (paisagem) 16f / 9f else 2f / 3f)
                // Escala no card, nao na coluna: o titulo abaixo nao deve
                // crescer junto, senao a fileira inteira treme ao navegar.
                .scale(if (focado) 1.08f else 1f)
                .clip(RoundedCornerShape(8.dp))
                .background(Cores.Superficie)
                .focusable(interactionSource = interacao),
        ) {
            val arte = if (paisagem) {
                ApiObaflix.imagem(item.background ?: item.poster, "w780")
            } else {
                ApiObaflix.imagem(item.poster, "w500")
            }
            if (arte != null) {
                AsyncImage(
                    model = arte,
                    contentDescription = item.titulo,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }

            if (focado) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Transparent)
                        .padding(2.dp),
                ) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .clip(RoundedCornerShape(8.dp))
                            .background(Cores.FocoHalo.copy(alpha = 0.14f)),
                    )
                }
            }

            // Barra de progresso: so em Continuar Assistindo, e so quando ha o
            // que mostrar. Uma barra vazia em todo card viraria ruido.
            if (item.progresso > 0f) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .fillMaxWidth()
                        .height(4.dp)
                        .background(Color.Black.copy(alpha = 0.55f)),
                ) {
                    Box(
                        Modifier
                            .fillMaxWidth(item.progresso)
                            .fillMaxHeight()
                            .background(Cores.Destaque),
                    )
                }
            }
        }

        // Titulo so no card focado: com todos visiveis a fileira vira parede de
        // texto, e o poster ja identifica o que a pessoa procura.
        if (focado) {
            Text(
                text = item.rotuloEpisodio?.let { "${item.titulo} · $it" } ?: item.titulo,
                color = Cores.Texto,
                fontSize = Escala.Rotulo,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
    }
}
