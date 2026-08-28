package com.obaflix.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.sessao.PareamentoTv
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import android.widget.Toast

/**
 * Casca do aplicativo.
 *
 * Uma tela só, com pilha de rotas em memória — nada de recriar Activity para
 * abrir um detalhe. É o que torna a volta instantânea e permite restaurar onde
 * a pessoa estava, que é o que mais incomoda quando falta numa TV.
 */

enum class SecaoTv(val rotulo: String, val chave: String) {
    INICIO("Início", "inicio"),
    FILMES("Filmes", "filme"),
    SERIES("Séries", "serie"),
    ANIMES("Animes", "anime"),
    DESENHOS("Desenhos", "desenho"),
}

sealed interface Rota {
    data class Secao(val secao: SecaoTv) : Rota
    data object Busca : Rota
    data class Detalhe(val id: String, val tipo: String) : Rota
    data class Player(
        val conteudoId: String,
        val tipo: String,
        val titulo: String,
        val temporada: Int? = null,
        val numeroEp: Int? = null,
        val episodioId: String? = null,
        val inicioSeg: Int = 0,
    ) : Rota
}

@Composable
fun AppTv() {
    val context = LocalContext.current
    val escopo = rememberCoroutineScope()
    val pilha = remember { mutableStateListOf<Rota>(Rota.Secao(SecaoTv.INICIO)) }
    var confirmandoSaida by remember { mutableStateOf(false) }

    val atual = pilha.last()
    // Player e detalhe ocupam a tela inteira: a barra superior sumiria atrás do
    // conteúdo e roubaria foco do que importa naquele momento.
    val comBarra = atual is Rota.Secao || atual is Rota.Busca

    fun abrir(rota: Rota) {
        pilha.add(rota)
        confirmandoSaida = false
    }

    fun trocarSecao(rota: Rota) {
        // Trocar de aba não empilha: a barra é navegação lateral, não um caminho.
        // Empilhar faria o Voltar percorrer todas as abas já visitadas.
        while (pilha.size > 1) pilha.removeAt(pilha.size - 1)
        pilha[0] = rota
        confirmandoSaida = false
    }

    BackHandler {
        when {
            pilha.size > 1 -> {
                pilha.removeAt(pilha.size - 1)
                confirmandoSaida = false
            }
            // Na raiz, sair exige confirmação. Esbarrar no Voltar e cair fora do
            // aplicativo é das coisas mais irritantes que uma TV faz.
            confirmandoSaida -> Unit
            else -> {
                confirmandoSaida = true
                Toast.makeText(context, "Aperte Voltar de novo para sair", Toast.LENGTH_SHORT).show()
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(Cores.Fundo)) {
        if (comBarra) {
            BarraSuperior(
                secaoAtiva = (atual as? Rota.Secao)?.secao,
                buscaAtiva = atual is Rota.Busca,
                aoEscolherSecao = { trocarSecao(Rota.Secao(it)) },
                aoBuscar = { trocarSecao(Rota.Busca) },
                aoSair = { escopo.launch { PareamentoTv.sair(context) } },
            )
        }

        Box(modifier = Modifier.fillMaxSize()) {
            val abrirItem: (Item) -> Unit = { abrir(Rota.Detalhe(it.id, it.tipo)) }

            when (val rota = atual) {
                is Rota.Secao -> when (rota.secao) {
                    SecaoTv.INICIO -> TelaHome(aoAbrir = abrirItem)
                    else -> TelaSecao(rota.secao, aoAbrir = abrirItem)
                }

                is Rota.Busca -> TelaBusca(aoAbrir = abrirItem)

                is Rota.Detalhe -> TelaDetalhe(
                    id = rota.id,
                    tipo = rota.tipo,
                    aoReproduzir = { abrir(it) },
                    aoAbrirRelacionado = abrirItem,
                )

                is Rota.Player -> TelaPlayer(
                    rota = rota,
                    aoFechar = { pilha.removeAt(pilha.size - 1) },
                    aoTrocarEpisodio = { nova ->
                        pilha[pilha.size - 1] = nova
                    },
                )
            }
        }
    }
}

/**
 * Barra superior.
 *
 * Fica no topo e não numa lateral porque as fileiras já usam a largura inteira;
 * um menu lateral comeria justamente o espaço onde os pôsteres precisam caber.
 */
@Composable
private fun BarraSuperior(
    secaoAtiva: SecaoTv?,
    buscaAtiva: Boolean,
    aoEscolherSecao: (SecaoTv) -> Unit,
    aoBuscar: () -> Unit,
    aoSair: () -> Unit,
) {
    val margem = margemSegura()

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .focusGroup()
            .padding(
                start = margem.calculateLeftPadding(androidx.compose.ui.unit.LayoutDirection.Ltr),
                end = margem.calculateRightPadding(androidx.compose.ui.unit.LayoutDirection.Ltr),
                top = 20.dp,
                bottom = 14.dp,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = "OBAFLIX",
            color = Cores.Destaque,
            fontSize = Escala.Secao,
            fontWeight = FontWeight.Black,
            modifier = Modifier.padding(end = 28.dp),
        )

        SecaoTv.entries.forEach { secao ->
            AbaSuperior(
                rotulo = secao.rotulo,
                ativa = secao == secaoAtiva,
                aoAcionar = { aoEscolherSecao(secao) },
            )
        }

        Box(Modifier.width(20.dp))
        AbaSuperior(rotulo = "Buscar", ativa = buscaAtiva, aoAcionar = aoBuscar)

        Box(Modifier.weight(1f))
        AbaSuperior(rotulo = "Sair", ativa = false, aoAcionar = aoSair)
    }
}

@Composable
private fun AbaSuperior(rotulo: String, ativa: Boolean, aoAcionar: () -> Unit) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()

    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .background(if (focado) Cores.Superficie else androidx.compose.ui.graphics.Color.Transparent)
                .focusable(interactionSource = interacao)
                .aoConfirmar(aoAcionar)
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            Text(
                text = rotulo,
                color = when {
                    focado -> Cores.Texto
                    ativa -> Cores.Texto
                    else -> Cores.TextoFraco
                },
                fontSize = Escala.Rotulo,
                fontWeight = if (ativa || focado) FontWeight.Bold else FontWeight.Normal,
            )
        }
        // Sublinhado marca a aba aberta; o fundo marca a que está sob o foco.
        // Separar os dois evita a confusão de "onde estou" com "onde vou".
        Box(
            Modifier
                .padding(top = 3.dp)
                .height(3.dp)
                .width(if (ativa) 26.dp else 0.dp)
                .background(Cores.Destaque, RoundedCornerShape(2.dp)),
        )
    }
}

/** Devolve o foco para o conteúdo assim que a tela entra. */
@Composable
fun focoInicial(): FocusRequester {
    val pedido = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { pedido.requestFocus() } }
    return pedido
}

fun Modifier.focoInicialEm(pedido: FocusRequester): Modifier = focusRequester(pedido)
