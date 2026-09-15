package com.obaflix.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import com.obaflix.tv.assinatura.AcaoDoPlano
import com.obaflix.tv.assinatura.Beneficio
import com.obaflix.tv.assinatura.CardDePlano
import com.obaflix.tv.assinatura.ContaDoPlano
import com.obaflix.tv.assinatura.PlanoTv
import com.obaflix.tv.assinatura.TomDoPlano
import com.obaflix.tv.assinatura.cardVizinho
import com.obaflix.tv.assinatura.cardsDosPlanos
import com.obaflix.tv.assinatura.focoDosPlanos
import com.obaflix.tv.assinatura.formatarPreco
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.navegacao.Camada
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.ui.componentes.BotaoTv
import com.obaflix.tv.ui.componentes.EspacoH
import com.obaflix.tv.ui.componentes.EspacoV
import com.obaflix.tv.ui.componentes.FocoBridge
import com.obaflix.tv.ui.componentes.escalaFoco
import com.obaflix.tv.ui.componentes.escalar
import com.obaflix.tv.ui.componentes.focavel
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay

/**
 * Planos na televisao.
 *
 * Cards grandes lado a lado, e nao uma tabela: a tres metros, uma grade de
 * celulas vira ruido. Cada card traz nome, marcador de nivel, preco, beneficios
 * na mesma ordem dos vizinhos e a acao.
 *
 * ## Dados
 *
 * Tudo do servidor, em paralelo: a vitrine (`/api/billing/plans`) e o plano da
 * conta (`/api/billing/me`). Sem os dois, a tela mostra erro com "Tentar de
 * novo" — nunca um card montado com valor local.
 *
 * ## Navegacao
 *
 * Ordem explicita: esquerda e direita entre cards, parando nas pontas; cima vai
 * ao Voltar; baixo, do Voltar, volta ao card que tinha o foco. A volta da
 * continuacao cai no card de onde a pessoa saiu (`MemoriaDosPlanos`).
 */

internal fun corDoTom(tom: TomDoPlano): Color = when (tom) {
    TomDoPlano.Azul -> Color(0xFF4C8DFF)
    TomDoPlano.Roxo -> Color(0xFFA66BFF)
    TomDoPlano.Ambar -> Color(0xFFF5B82E)
    TomDoPlano.Neutro -> Color(0xFFC4C4C4)
}

/** Texto sobre o preenchimento do tom. Ambar e neutro sao claros demais para branco. */
internal fun textoSobreTom(tom: TomDoPlano): Color =
    if (tom == TomDoPlano.Ambar || tom == TomDoPlano.Neutro) Color(0xFF1A1206) else Color.White

private const val TENTATIVAS_DE_FOCO = 12

@Composable
fun TelaPlanos(camada: Camada.Planos) {
    var conta by remember { mutableStateOf<ContaDoPlano?>(null) }
    var catalogo by remember { mutableStateOf<List<PlanoTv>?>(null) }
    var falhou by remember { mutableStateOf(false) }
    var tentativa by remember { mutableStateOf(0) }

    LaunchedEffect(tentativa) {
        falhou = false
        val (novaConta, novoCatalogo) = coroutineScope {
            val c = async { ApiObaflix.contaDoPlano() }
            val p = async { ApiObaflix.catalogoDePlanos() }
            c.await() to p.await()
        }
        if (novaConta == null || novoCatalogo == null) {
            falhou = true
        } else {
            conta = novaConta
            catalogo = novoCatalogo
        }
    }

    BackHandler(enabled = true) { Navegacao.voltar() }

    val cards = remember(conta, catalogo) {
        val c = conta
        val p = catalogo
        if (c != null && p != null) cardsDosPlanos(p, c) else emptyList()
    }
    val requisitores = remember(cards.size) { List(maxOf(cards.size, 1)) { FocusRequester() } }
    val voltar = remember { FocusRequester() }
    val tentarDeNovo = remember { FocusRequester() }
    var temFoco by remember { mutableStateOf(false) }
    var cardComFoco by remember { mutableStateOf<Int?>(null) }

    LaunchedEffect(cards, falhou, FocoBridge.pulso) {
        val indice = if (!falhou && cards.isNotEmpty()) focoDosPlanos(camada.memoria.indiceFocado, cards) else null
        val alvo = when {
            falhou -> tentarDeNovo
            indice != null -> requisitores[indice]
            else -> voltar
        }
        repeat(TENTATIVAS_DE_FOCO) {
            if (Navegacao.pilha.lastOrNull() !== camada) return@LaunchedEffect
            val jaFocado = if (indice != null) cardComFoco == indice else temFoco
            if (jaFocado) return@LaunchedEffect
            withFrameNanos { }
            runCatching { alvo.requestFocus() }
            delay(50)
        }
    }

    val margem = margemHorizontal()
    val carregado = conta != null && catalogo != null

    Box(Modifier.fillMaxSize().background(Cores.Fundo)) {
        Box(
            Modifier.fillMaxSize().background(
                Brush.verticalGradient(0f to Color(0xFF17131F), 0.55f to Cores.Fundo),
            ),
        )

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(start = margem, end = margem, top = margemVertical(), bottom = margemVertical())
                .onFocusChanged { temFoco = it.hasFocus },
        ) {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = "Planos Obaflix",
                        color = Cores.Texto,
                        fontSize = 30.sp,
                        fontWeight = FontWeight.Black,
                    )
                    EspacoV(4.dp)
                    Text(
                        text = "Escolha um plano e conclua a assinatura pelo celular.",
                        color = Cores.TextoFraco,
                        fontSize = 17.sp,
                    )
                }
                BotaoTv(
                    texto = "Voltar",
                    modifier = Modifier
                        .focusRequester(voltar)
                        .focusProperties {
                            if (cards.isNotEmpty()) {
                                down = requisitores[focoDosPlanos(camada.memoria.indiceFocado, cards)]
                            }
                        },
                    aoClicar = { Navegacao.voltar() },
                )
            }

            EspacoV(20.dp)

            when {
                falhou -> Aviso(
                    titulo = "Não foi possível carregar os planos",
                    detalhe = "Verifique a conexão e tente de novo.",
                ) {
                    BotaoTv(
                        texto = "Tentar de novo",
                        principal = true,
                        modifier = Modifier.focusRequester(tentarDeNovo),
                    ) { tentativa++ }
                }

                !carregado -> Aviso(titulo = "Carregando planos…", detalhe = "")

                cards.isEmpty() -> Aviso(
                    titulo = "Planos indisponíveis no momento",
                    detalhe = "Tente novamente mais tarde.",
                )

                else -> Row(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    cards.forEachIndexed { i, card ->
                        CardDoPlano(
                            card = card,
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxHeight()
                                .focusRequester(requisitores[i])
                                .focusProperties {
                                    left = requisitores[cardVizinho(i, -1, cards.size)]
                                    right = requisitores[cardVizinho(i, +1, cards.size)]
                                    up = voltar
                                    down = requisitores[i]
                                },
                            aoFocar = {
                                cardComFoco = i
                                camada.memoria.indiceFocado = i
                            },
                            aoEscolher = {
                                if (card.acao.acionavel) Navegacao.abrir(Camada.AssinarForaDaTv(card.plano))
                            },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.ColumnScope.Aviso(
    titulo: String,
    detalhe: String,
    acao: @Composable () -> Unit = {},
) {
    Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(text = titulo, color = Cores.Texto, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            if (detalhe.isNotBlank()) {
                EspacoV(8.dp)
                Text(text = detalhe, color = Cores.TextoFraco, fontSize = 17.sp)
            }
            EspacoV(20.dp)
            acao()
        }
    }
}

@Composable
private fun CardDoPlano(
    card: CardDePlano,
    modifier: Modifier,
    aoFocar: () -> Unit,
    aoEscolher: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    // Discreto: o card ja e grande, e crescer muito o empurraria para fora da
    // margem segura. A borda na cor do plano faz o resto.
    val escala = escalaFoco(focado, alvo = 1.03f)
    val tom = corDoTom(card.plano.tom)
    val forma = RoundedCornerShape(18.dp)
    val preco = card.plano.precoDeEntrada

    Column(
        modifier = modifier
            .escalar(escala)
            .clip(forma)
            .background(if (focado) Cores.SuperficieAlta else Cores.Superficie)
            .background(
                Brush.verticalGradient(
                    0f to tom.copy(alpha = if (focado) 0.34f else 0.16f),
                    0.5f to Color.Transparent,
                ),
            )
            .border(
                width = if (focado) 3.dp else 1.dp,
                color = if (focado) tom else Cores.SuperficieAlta,
                shape = forma,
            )
            .focavel(interacao = interacao, aoFocar = aoFocar, aoClicar = aoEscolher)
            .padding(horizontal = 20.dp, vertical = 16.dp),
    ) {
        Box(Modifier.height(26.dp)) {
            card.selo?.let { selo ->
                SeloDoPlano(
                    texto = selo,
                    fundo = if (card.atual) Cores.Texto else tom,
                    cor = if (card.atual) Color(0xFF101014) else textoSobreTom(card.plano.tom),
                )
            }
        }
        EspacoV(8.dp)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = card.plano.nome,
                color = Cores.Texto,
                fontSize = 24.sp,
                fontWeight = FontWeight.Black,
                maxLines = 1,
            )
            EspacoH(10.dp)
            MarcadorDeNivel(card.nivel, tom)
        }
        if (preco != null) {
            Row(verticalAlignment = Alignment.Bottom) {
                Text(
                    text = formatarPreco(preco.precoCentavos, preco.moeda),
                    color = tom,
                    fontSize = 28.sp,
                    fontWeight = FontWeight.Black,
                    maxLines = 1,
                )
                EspacoH(6.dp)
                Text(
                    text = "/ " + preco.rotulo,
                    color = Cores.TextoFraco,
                    fontSize = 15.sp,
                    maxLines = 1,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }
        } else {
            Text(text = "Sem preço disponível", color = Cores.TextoApagado, fontSize = 18.sp, maxLines = 1)
        }
        EspacoV(10.dp)
        Box(Modifier.fillMaxWidth().height(1.dp).background(Cores.Texto.copy(alpha = 0.12f)))
        EspacoV(10.dp)
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            card.plano.beneficios.forEach { LinhaDeBeneficio(it, tom) }
        }
        EspacoV(10.dp)
        RodapeDoCard(card, focado)
    }
}

/**
 * Um, dois ou tres pontos: o plano e identificado por texto e forma, alem da cor.
 */
@Composable
private fun MarcadorDeNivel(nivel: Int, tom: Color) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        repeat(nivel.coerceIn(1, 3)) {
            Box(Modifier.size(9.dp).clip(RoundedCornerShape(50)).background(tom))
        }
    }
}

@Composable
private fun LinhaDeBeneficio(beneficio: Beneficio, tom: Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = if (beneficio.incluido) "✓" else "–",
            color = if (beneficio.incluido) tom else Cores.TextoApagado,
            fontSize = 15.sp,
            fontWeight = FontWeight.Black,
            modifier = Modifier.width(20.dp),
        )
        Text(
            text = beneficio.texto,
            color = if (beneficio.incluido) Cores.Texto else Cores.TextoApagado,
            fontSize = 15.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * A acao do card. Preenchimento so quando ha acao — um estado sem acao
 * desenhado como botao pareceria clicavel e nao faria nada.
 */
@Composable
private fun RodapeDoCard(card: CardDePlano, focado: Boolean) {
    val rotulo = card.acao.rotulo
    val forma = RoundedCornerShape(10.dp)
    when {
        rotulo != null && card.acao.acionavel -> Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
                .clip(forma)
                .background(if (focado) Cores.FocoHalo else corDoTom(card.plano.tom)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = rotulo,
                color = if (focado) Color(0xFF101014) else textoSobreTom(card.plano.tom),
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
            )
        }

        rotulo != null -> Box(Modifier.fillMaxWidth().height(48.dp), contentAlignment = Alignment.Center) {
            Text(rotulo, color = Cores.TextoApagado, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        }

        card.atual -> Box(Modifier.fillMaxWidth().height(48.dp), contentAlignment = Alignment.Center) {
            Text("Este é o seu plano", color = Cores.TextoFraco, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
        }

        else -> Box(Modifier.height(48.dp))
    }
}

@Composable
internal fun SeloDoPlano(texto: String, fundo: Color, cor: Color) {
    Text(
        text = texto.uppercase(),
        color = cor,
        fontSize = 12.sp,
        fontWeight = FontWeight.Black,
        maxLines = 1,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(fundo)
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

/** Chave de restauracao do botao da barra: a volta dos planos cai nele. */
const val CHAVE_FOCO_PLANOS = "barra#planos"

/**
 * Entrada permanente da barra, ao lado do Perfil.
 *
 * Mesma forma do botao de Perfil, sem cor de chamada: e uma entrada fixa, nao um
 * anuncio. As chamadas contextuais ("Ver planos") aparecem so onde um beneficio
 * falta.
 */
@Composable
internal fun BotaoPlanosDaBarra() {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.06f)

    Box(
        modifier = Modifier
            .escalar(escala)
            .clip(RoundedCornerShape(50))
            .background(if (focado) Cores.FocoHalo else Cores.Superficie)
            .focavel(interacao = interacao, chaveFoco = CHAVE_FOCO_PLANOS) { Navegacao.abrirPlanos() }
            .padding(horizontal = 18.dp, vertical = 8.dp),
    ) {
        Text(
            text = "Planos",
            color = if (focado) Color(0xFF101014) else Cores.TextoFraco,
            fontSize = Escala.Rotulo,
        )
    }
}
