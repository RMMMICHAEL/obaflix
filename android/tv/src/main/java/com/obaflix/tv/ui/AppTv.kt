package com.obaflix.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
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
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.navegacao.Aba
import com.obaflix.tv.navegacao.Camada
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.sessao.PareamentoTv
import com.obaflix.tv.ui.componentes.EspacoH
import com.obaflix.tv.ui.componentes.LocalRestaurador
import com.obaflix.tv.ui.componentes.Restaurador
import com.obaflix.tv.ui.componentes.escalaFoco
import com.obaflix.tv.ui.componentes.escalar
import com.obaflix.tv.ui.componentes.focavel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Moldura do aplicativo.
 *
 * Uma composicao so, com tres camadas empilhadas:
 *
 *  1. **Arte de fundo** — acompanha o que esta focado, com fusao lenta. E o que
 *     tira a tela do aspecto de lista tecnica: o catalogo passa a ocupar o
 *     fundo inteiro em vez de flutuar sobre chapado.
 *  2. **Moldura** — barra de abas e o conteudo da aba corrente. As abas ficam
 *     compostas mesmo quando cobertas, e e isso que devolve a pessoa a mesma
 *     fileira e ao mesmo card quando ela volta de um conteudo.
 *  3. **Camadas** — ficha e player, por cima de tudo.
 *
 * Enquanto ha camada aberta, a moldura inteira e desativada para o foco. Sem
 * isso, uma seta para baixo dentro da ficha encontraria os cards da Home
 * escondidos atras e o cursor sumiria da tela.
 */
@Composable
fun AppTv() {
    val restaurador = remember { Restaurador() }
    var fundoDesejado by remember { mutableStateOf<String?>(null) }
    var fundoAtual by remember { mutableStateOf<String?>(null) }

    // A arte so troca depois de o foco parar. Sem esta pausa, atravessar uma
    // fileira com a seta pressionada dispararia um download de backdrop por
    // card — trabalho jogado fora e engasgo garantido em TV Box fraca.
    LaunchedEffect(fundoDesejado) {
        delay(450)
        fundoAtual = fundoDesejado
    }

    // Fechou a ultima camada: o cursor volta para o card de onde saiu. A
    // rolagem ja esta preservada porque a moldura nunca foi descartada — o que
    // se restaura aqui e so a posicao do foco.
    LaunchedEffect(Navegacao.emCamada) {
        if (!Navegacao.emCamada) {
            delay(60)
            restaurador.restaurar()
        }
    }

    CompositionLocalProvider(LocalRestaurador provides restaurador) {
        Box(Modifier.fillMaxSize().background(Cores.Fundo)) {

            FundoDinamico(fundoAtual)

            Moldura(
                bloqueado = Navegacao.emCamada,
                aoFocarArte = { fundoDesejado = it },
            )

            Navegacao.pilha.forEach { camada ->
                when (camada) {
                    is Camada.Detalhe -> TelaDetalhe(camada)
                    is Camada.Player -> TelaPlayer(camada.pedido)
                }
            }
        }
    }
}

/**
 * Arte de fundo da moldura.
 *
 * Escurecida em duas passadas: um veu uniforme para o texto ter contraste em
 * qualquer cena e um degrade de baixo para cima, que e onde ficam as fileiras.
 * Sem os dois, poster claro sobre backdrop claro fica ilegivel.
 */
@Composable
private fun FundoDinamico(caminho: String?) {
    Crossfade(
        targetState = ApiObaflix.imagem(caminho, "w780"),
        animationSpec = tween(700),
        label = "fundo",
    ) { url ->
        if (url != null) {
            Box(Modifier.fillMaxSize()) {
                AsyncImage(
                    model = url,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
                Box(Modifier.fillMaxSize().background(Cores.Veu.copy(alpha = 0.72f)))
                Box(
                    Modifier.fillMaxSize().background(
                        Brush.verticalGradient(
                            0f to Cores.Veu.copy(alpha = 0.55f),
                            0.45f to Cores.Veu.copy(alpha = 0.80f),
                            1f to Cores.Veu,
                        ),
                    ),
                )
            }
        }
    }
}

@Composable
private fun Moldura(bloqueado: Boolean, aoFocarArte: (String?) -> Unit) {
    val margem = margemHorizontal()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .focusProperties { canFocus = !bloqueado }
            .focusGroup(),
    ) {
        BarraTopo(margem = margem, bloqueada = bloqueado)

        when (Navegacao.aba) {
            Aba.Inicio -> TelaHome(aoFocarArte)
            Aba.Filmes -> TelaCatalogo(Aba.Filmes, aoFocarArte)
            Aba.Series -> TelaCatalogo(Aba.Series, aoFocarArte)
            Aba.Animes -> TelaCatalogo(Aba.Animes, aoFocarArte)
            Aba.Kids -> TelaCatalogo(Aba.Kids, aoFocarArte)
            Aba.Busca -> TelaBusca()
        }
    }

    // BACK na moldura: de qualquer aba volta para o Inicio. Sair do aplicativo
    // so acontece a partir do Inicio, que e o comportamento que a televisao
    // ensina — ninguem espera fechar o app apertando BACK dentro de "Filmes".
    BackHandler(enabled = !bloqueado && Navegacao.aba != Aba.Inicio) {
        Navegacao.irPara(Aba.Inicio)
    }
}

/**
 * Barra de abas.
 *
 * O foco destaca; o OK e que troca de aba. Trocar no foco pareceria mais fluido
 * por um segundo e custaria uma consulta ao catalogo a cada passagem de seta —
 * seis abas atravessadas seriam seis cargas que ninguem pediu.
 */
@Composable
private fun BarraTopo(margem: androidx.compose.ui.unit.Dp, bloqueada: Boolean) {
    val context = LocalContext.current
    val escopo = androidx.compose.runtime.rememberCoroutineScope()
    val primeiroItem = remember { FocusRequester() }
    var relogio by remember { mutableStateOf(agora()) }

    LaunchedEffect(Unit) {
        while (true) {
            relogio = agora()
            delay(20_000)
        }
    }

    // O foco inicial do aplicativo nasce na barra. E o unico ponto da tela em
    // que a pessoa sempre se reconhece ao ligar a televisao.
    LaunchedEffect(Unit) {
        if (!bloqueada) runCatching { primeiroItem.requestFocus() }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = margem, end = margem, top = 20.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Marca()
        EspacoH(36.dp)

        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.focusGroup(),
        ) {
            Aba.values().forEachIndexed { indice, aba ->
                ItemMenu(
                    aba = aba,
                    selecionada = Navegacao.aba == aba,
                    modifier = if (indice == 0) Modifier.focusRequester(primeiroItem) else Modifier,
                )
            }
        }

        Box(Modifier.weight(1f))

        Text(text = relogio, color = Cores.TextoFraco, fontSize = Escala.Rotulo)
        EspacoH(20.dp)
        BotaoConta(aoSair = { escopo.launch { PareamentoTv.sair(context) } })
    }
}

@Composable
private fun Marca() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(30.dp).clip(RoundedCornerShape(8.dp)).background(Cores.Destaque),
        )
        EspacoH(10.dp)
        Text(
            text = "OBAFLIX",
            color = Cores.Texto,
            fontSize = Escala.Secao,
            fontWeight = FontWeight.Black,
        )
    }
}

@Composable
private fun ItemMenu(aba: Aba, selecionada: Boolean, modifier: Modifier = Modifier) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.06f)

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .escalar(escala)
            .clip(RoundedCornerShape(8.dp))
            .background(if (focado) Cores.FocoHalo else Color.Transparent)
            .focavel(interacao = interacao) { Navegacao.irPara(aba) }
            .padding(horizontal = 18.dp, vertical = 8.dp),
    ) {
        Text(
            text = aba.rotulo,
            color = when {
                focado -> Color(0xFF101014)
                selecionada -> Cores.Texto
                else -> Cores.TextoApagado
            },
            fontSize = Escala.Rotulo,
            fontWeight = if (selecionada || focado) FontWeight.Black else FontWeight.Medium,
        )
        // Sublinhado vermelho: diz qual aba esta aberta mesmo quando o foco ja
        // desceu para o catalogo e nao ha mais nada destacado la em cima.
        Box(
            Modifier
                .padding(top = 4.dp)
                .size(width = 22.dp, height = 3.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(if (selecionada) Cores.Destaque else Color.Transparent),
        )
    }
}

/**
 * Conta.
 *
 * Sair passou a viver aqui, e nao no meio do destaque: e uma acao rara, e
 * ocupar espaco nobre da Home com ela era sintoma de tela de fundacao. Pede
 * confirmacao porque um OK acidental no controle remoto desfaria o pareamento
 * e obrigaria a pessoa a pegar o celular de novo.
 */
@Composable
private fun BotaoConta(aoSair: () -> Unit) {
    var confirmando by remember { mutableStateOf(false) }
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.06f)

    Box(
        modifier = Modifier
            .escalar(escala)
            .clip(RoundedCornerShape(50))
            .background(if (focado) Cores.FocoHalo else Cores.Superficie)
            .focavel(interacao = interacao) {
                if (confirmando) aoSair() else confirmando = true
            }
            .padding(horizontal = 18.dp, vertical = 8.dp),
    ) {
        Text(
            text = if (confirmando) "Confirmar saída" else "Conta",
            color = if (focado) Color(0xFF101014) else Cores.TextoFraco,
            fontSize = Escala.Rotulo,
        )
    }

    // Sai do modo de confirmacao sozinho: um "Confirmar saída" esquecido na
    // barra vira armadilha para o proximo OK.
    LaunchedEffect(confirmando, focado) {
        if (confirmando && !focado) {
            delay(4000)
            confirmando = false
        }
    }
}

private fun agora(): String = SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())
