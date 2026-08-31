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
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalInputModeManager
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
import com.obaflix.tv.ui.componentes.EspacoV
import com.obaflix.tv.ui.componentes.LocalRestaurador
import com.obaflix.tv.ui.componentes.Restaurador
import com.obaflix.tv.ui.componentes.escalaFoco
import com.obaflix.tv.ui.componentes.escalar
import com.obaflix.tv.ui.componentes.focavel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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
    val focoMoldura = remember { com.obaflix.tv.ui.componentes.FocoMoldura() }
    var fundoDesejado by remember { mutableStateOf<String?>(null) }
    var fundoAtual by remember { mutableStateOf<String?>(null) }

    // Coloca o app em modo de entrada por teclado/D-pad. E a API oficial do
    // Compose para o mesmo problema que o requestFocusFromTouch resolve na
    // Activity: sem isso, um aparelho que abriu em modo toque nao entrega foco a
    // composable nenhum, e as setas ficam mudas ate um clique. Repetimos porque
    // a primeira chamada pode chegar antes de a janela estar pronta.
    val inputMode = LocalInputModeManager.current
    LaunchedEffect(Unit) {
        repeat(10) {
            inputMode.requestInputMode(InputMode.Keyboard)
            delay(80)
        }
    }

    // Recuperacao do bug de foco do Compose 1.6 (ver MainActivity.dispatchKeyEvent
    // e FocoBridge): quando a Activity intercepta o "isAttached", limpamos o foco
    // quebrado e pulsamos — as telas refazem a restauracao e o cursor volta ao
    // card, sem crash e sem precisar de mouse.
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    androidx.compose.runtime.DisposableEffect(Unit) {
        com.obaflix.tv.ui.componentes.FocoBridge.recuperar = {
            runCatching { focusManager.clearFocus(force = true) }
            com.obaflix.tv.ui.componentes.FocoBridge.pulso++
        }
        onDispose { com.obaflix.tv.ui.componentes.FocoBridge.recuperar = null }
    }

    // A arte so troca depois de o foco parar. Sem esta pausa, atravessar uma
    // fileira com a seta pressionada dispararia um download de backdrop por
    // card — trabalho jogado fora e engasgo garantido em TV Box fraca.
    LaunchedEffect(fundoDesejado) {
        delay(450)
        fundoAtual = fundoDesejado
    }

    CompositionLocalProvider(
        LocalRestaurador provides restaurador,
        com.obaflix.tv.ui.componentes.LocalFocoMoldura provides focoMoldura,
    ) {
        Box(Modifier.fillMaxSize().background(Cores.Fundo)) {
            // Renderiza SO a superficie do topo. E a correcao de raiz do crash
            // "LayoutCoordinate operations are only valid when isAttached is
            // true": antes a moldura ficava composta sob a ficha/player, a
            // LazyRow reciclava o card que ainda constava focado, e a proxima
            // seta fazia a busca de foco andar por um no desanexado. Sem a tela
            // de baixo composta, esse no nao existe. A rolagem e o card de
            // origem voltam pela restauracao de foco + estado saveable da lista.
            val topo = Navegacao.pilha.lastOrNull()
            when (topo) {
                null -> {
                    FundoDinamico(fundoAtual)
                    Moldura(aoFocarArte = { fundoDesejado = it })
                }
                is Camada.Detalhe -> TelaDetalhe(topo)
                is Camada.Player -> TelaPlayer(topo.pedido)
                is Camada.Perfil -> TelaPerfil()
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
private fun Moldura(aoFocarArte: (String?) -> Unit) {
    val margem = margemHorizontal()
    val foco = com.obaflix.tv.ui.componentes.LocalFocoMoldura.current
    // A aba corrente e registrada depois da composicao, nao durante: e ela que
    // diz a primeira fileira a qual opcao da barra devolver o cursor na seta
    // para cima. Em SideEffect porque escrever estado no meio da composicao que
    // sera lido na resolucao de foco pede recomposicao no meio do caminho.
    androidx.compose.runtime.SideEffect { foco.abaAtiva = Navegacao.aba.name }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .focusGroup(),
    ) {
        BarraTopo(margem = margem)

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
    BackHandler(enabled = Navegacao.aba != Aba.Inicio) {
        Navegacao.irPara(Aba.Inicio)
    }
}

/**
 * Espera antes de a selecao por foco valer.
 *
 * Curto o bastante para parecer imediato a quem para na aba; longo o bastante
 * para quem atravessa a barra inteira nao disparar uma carga por aba.
 */
private const val ATRASO_ABA_MS = 280L

/**
 * Barra de abas.
 *
 * A aba troca no **foco**, nao no OK: mover a seta para Filmes ja abre Filmes.
 * E o comportamento que se espera de uma televisao — apertar OK para confirmar
 * uma navegacao que ja esta visivel e um passo a mais sem funcao.
 *
 * O custo que o OK evitava (uma carga por aba atravessada) e resolvido pelo
 * atraso de ATRASO_ABA_MS: quem passa reto por quatro abas nao dispara carga
 * nenhuma, porque `LaunchedEffect(focado)` cancela a espera anterior quando o
 * foco sai. So a aba onde a seta parou chega a carregar.
 */
@Composable
private fun BarraTopo(margem: androidx.compose.ui.unit.Dp) {
    val context = LocalContext.current
    val escopo = androidx.compose.runtime.rememberCoroutineScope()
    val restaurador = LocalRestaurador.current
    val foco = com.obaflix.tv.ui.componentes.LocalFocoMoldura.current
    // A primeira opcao da barra e o alvo do foco inicial. E o mesmo requisitor
    // que ela usa para receber a seta para cima vinda do conteudo — um por aba,
    // guardado no FocoMoldura, sem um segundo requisitor paralelo.
    val primeiroItem = foco.daAba(Aba.values().first().name)

    // A barra so puxa o foco no primeiro boot — quando nenhum card foi focado
    // ainda. Nos retornos (ficha/busca/player -> aba) quem restaura e o proprio
    // conteudo da tela, que devolve o foco ao card de origem; se a barra tambem
    // pedisse, disputaria com ele e o cursor pularia para o topo.
    LaunchedEffect(Unit) {
        if (restaurador.endereco != null) return@LaunchedEffect
        repeat(12) {
            if (restaurador.endereco != null) return@LaunchedEffect
            android.util.Log.d("ObaFoco", "barra pedindo foco inicial")
            runCatching { primeiroItem.requestFocus() }
            delay(60)
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = margem, end = margem, top = 16.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Marca()
        EspacoH(24.dp)

        // As abas ficam no meio, com peso, para caberem em qualquer resolucao. O
        // texto nunca quebra (softWrap desligado no ItemMenu): se faltar largura,
        // encolhe/rola em vez de virar duas linhas.
        Row(
            horizontalArrangement = Arrangement.spacedBy(2.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .weight(1f)
                .focusGroup()
                // O sinal que separa "trocar de aba" de "entrar no conteudo".
                // Enquanto o cursor estiver em qualquer opcao daqui, nenhuma
                // tela puxa o foco para si ao terminar de carregar.
                .onFocusChanged { foco.barraComFoco = it.hasFocus },
        ) {
            Aba.values().forEach { aba ->
                ItemMenu(
                    aba = aba,
                    selecionada = Navegacao.aba == aba,
                    modifier = Modifier.focusRequester(foco.daAba(aba.name)),
                )
            }
        }

        EspacoH(16.dp)
        BotaoPerfil(aoAbrir = { Navegacao.abrir(Camada.Perfil) })
    }
}

@Composable
private fun Marca() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(26.dp).clip(RoundedCornerShape(7.dp)).background(Cores.Destaque),
        )
        EspacoH(8.dp)
        Text(
            text = "OBAFLIX",
            color = Cores.Texto,
            fontSize = Escala.Rotulo,
            fontWeight = FontWeight.Black,
            maxLines = 1,
            softWrap = false,
        )
    }
}

@Composable
private fun ItemMenu(aba: Aba, selecionada: Boolean, modifier: Modifier = Modifier) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.06f)

    // Selecao por foco, com espera. O cancelamento vem de graca: quando o foco
    // muda, o Compose cancela esta corrotina e a aba que ficou para tras nunca
    // chega a pedir nada ao servidor.
    LaunchedEffect(focado) {
        if (!focado || selecionada) return@LaunchedEffect
        kotlinx.coroutines.delay(ATRASO_ABA_MS)
        Navegacao.irPara(aba)
    }

    // Como o item_tab_recyclerview da referencia: sem preenchimento no foco. O
    // texto clareia e o sublinhado (vermelho Obaflix) marca a aba aberta. O
    // texto e uma linha so (softWrap = false) — BUSCAR nunca quebra na vertical.
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier
            .escalar(escala)
            // OK continua valendo, para quem tem o habito de confirmar.
            .focavel(interacao = interacao) { Navegacao.irPara(aba) }
            .padding(horizontal = 12.dp, vertical = 2.dp),
    ) {
        Text(
            text = aba.rotulo,
            color = when {
                focado || selecionada -> Cores.Texto
                else -> Cores.TextoFraco
            },
            fontSize = Escala.Rotulo,
            fontWeight = if (selecionada || focado) FontWeight.Black else FontWeight.Medium,
            maxLines = 1,
            softWrap = false,
        )
        EspacoV(5.dp)
        Box(
            Modifier
                .size(width = 22.dp, height = 3.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(
                    when {
                        selecionada -> Cores.Destaque
                        focado -> Cores.Texto.copy(alpha = 0.5f)
                        else -> Color.Transparent
                    },
                ),
        )
    }
}

/**
 * Botao de Perfil na barra. Abre a area completa (favoritos, historico,
 * continuar assistindo, sair) — o "Conta" que so tinha o nome virou isso.
 */
@Composable
private fun BotaoPerfil(aoAbrir: () -> Unit) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.06f)

    Box(
        modifier = Modifier
            .escalar(escala)
            .clip(RoundedCornerShape(50))
            .background(if (focado) Cores.FocoHalo else Cores.Superficie)
            .focavel(interacao = interacao) { aoAbrir() }
            .padding(horizontal = 18.dp, vertical = 8.dp),
    ) {
        Text(
            text = "Perfil",
            color = if (focado) Color(0xFF101014) else Cores.TextoFraco,
            fontSize = Escala.Rotulo,
        )
    }
}
