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
import com.obaflix.tv.assinatura.CatalogoDePlanosTv
import com.obaflix.tv.assinatura.ContaDoPlano
import com.obaflix.tv.assinatura.TomDoPlano
import com.obaflix.tv.assinatura.cardVizinho
import com.obaflix.tv.assinatura.cardsDosPlanos
import com.obaflix.tv.assinatura.focoDosPlanos
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
import kotlinx.coroutines.delay

/**
 * Planos na televisao.
 *
 * Tres cards grandes lado a lado, e nao uma tabela: a tres metros, uma grade de
 * celulas com "sim/nao" vira ruido. Cada card carrega o proprio preco, a propria
 * cor e os beneficios na mesma ordem dos vizinhos, entao a comparacao se faz
 * passando o cursor.
 *
 * ## Navegacao
 *
 * Ordem explicita, e nao busca espacial: esquerda e direita andam entre os
 * cards e param nas pontas (`cardVizinho`); cima vai ao Voltar; baixo, do
 * Voltar, volta ao card que tinha o foco. O cursor nasce no card que
 * `focoInicialDosPlanos` escolhe, e a volta da continuacao cai no card de onde a
 * pessoa saiu (`MemoriaDosPlanos`).
 *
 * ## O que nao decide
 *
 * O plano atual vem de `/api/billing/me`. Os estados dos cards sao so desenho —
 * nada aqui libera canal, VIP ou reproducao. Sem conta carregada, nao ha
 * palpite: a tela mostra erro com "Tentar de novo".
 */

internal fun corDoTom(tom: TomDoPlano): Color = when (tom) {
    TomDoPlano.Azul -> Color(0xFF4C8DFF)
    TomDoPlano.Roxo -> Color(0xFFA66BFF)
    TomDoPlano.Ambar -> Color(0xFFF5B82E)
}

/** Texto sobre o preenchimento do tom. Ambar e claro demais para branco. */
internal fun textoSobreTom(tom: TomDoPlano): Color =
    if (tom == TomDoPlano.Ambar) Color(0xFF1A1206) else Color.White

private const val TENTATIVAS_DE_FOCO = 12

@Composable
fun TelaPlanos(camada: Camada.Planos) {
    var conta by remember { mutableStateOf<ContaDoPlano?>(null) }
    var falhou by remember { mutableStateOf(false) }
    var tentativa by remember { mutableStateOf(0) }

    LaunchedEffect(tentativa) {
        falhou = false
        val resposta = ApiObaflix.contaDoPlano()
        if (resposta == null) falhou = true else conta = resposta
    }

    BackHandler(enabled = true) { Navegacao.voltar() }

    val cards = remember(conta) { conta?.let { cardsDosPlanos(it) }.orEmpty() }
    val requisitores = remember { List(CatalogoDePlanosTv.TODOS.size) { FocusRequester() } }
    val voltar = remember { FocusRequester() }
    val tentarDeNovo = remember { FocusRequester() }
    var temFoco by remember { mutableStateOf(false) }
    var cardComFoco by remember { mutableStateOf<Int?>(null) }

    // Foco inicial e restauracao. Insiste ate o alvo confirmar o foco, porque o
    // primeiro pedido pode chegar antes de o card ser posicionado; e para quando
    // esta tela deixa de ser o topo.
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
                falhou -> Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(
                            text = "Não foi possível carregar seu plano",
                            color = Cores.Texto,
                            fontSize = 22.sp,
                            fontWeight = FontWeight.Bold,
                        )
                        EspacoV(8.dp)
                        Text("Verifique a conexão e tente de novo.", color = Cores.TextoFraco, fontSize = 17.sp)
                        EspacoV(20.dp)
                        BotaoTv(
                            texto = "Tentar de novo",
                            principal = true,
                            modifier = Modifier.focusRequester(tentarDeNovo),
                        ) { tentativa++ }
                    }
                }

                conta == null -> Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    Text("Carregando planos…", color = Cores.TextoFraco, fontSize = 18.sp)
                }

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
                                if (card.acao != AcaoDoPlano.Nenhuma) {
                                    Navegacao.abrir(Camada.AssinarForaDaTv(card.plano.id))
                                }
                            },
                        )
                    }
                }
            }
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
        Text(
            text = card.plano.nome,
            color = Cores.Texto,
            fontSize = 24.sp,
            fontWeight = FontWeight.Black,
            maxLines = 1,
        )
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                text = card.plano.preco,
                color = tom,
                fontSize = 28.sp,
                fontWeight = FontWeight.Black,
                maxLines = 1,
            )
            EspacoH(6.dp)
            Text(
                text = "/ " + card.plano.periodo,
                color = Cores.TextoFraco,
                fontSize = 15.sp,
                maxLines = 1,
                modifier = Modifier.padding(bottom = 4.dp),
            )
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
 * A acao do card. So ha botao desenhado quando ha acao — um "Plano atual" em
 * forma de botao pareceria clicavel e nao faria nada.
 */
@Composable
private fun RodapeDoCard(card: CardDePlano, focado: Boolean) {
    val rotulo = card.acao.rotulo
    val forma = RoundedCornerShape(10.dp)
    when {
        rotulo != null -> Box(
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
 * falta — canais, recusa de conteudo, convite antes do video.
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
