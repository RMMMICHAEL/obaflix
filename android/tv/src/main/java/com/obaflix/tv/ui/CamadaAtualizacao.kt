package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.tv.material3.Text
import kotlinx.coroutines.delay
import com.obaflix.tv.ui.componentes.escalaFoco
import com.obaflix.tv.ui.componentes.escalar
import com.obaflix.tv.ui.componentes.focavel
import com.obaflix.update.PlatformUpdate

/**
 * Ponte entre a extração e a interface para a atualização — mesmo desenho do
 * `PonteDesafio` em [CamadaDesafio], para o mesmo tipo de problema: a lógica
 * de checagem/download roda fora da composição (em [com.obaflix.update.Atualizador],
 * compartilhada com o `:app`), e a Activity/AppTv precisa de um jeito simples
 * de dizer "há uma atualização pronta" sem acoplar as duas camadas.
 */
object PonteAtualizacao {
    var pronta by mutableStateOf<PlatformUpdate?>(null)
    var aoInstalar: (() -> Unit)? = null
}

/**
 * Cartão "atualização disponível", dispensável: BACK ou "Agora não" fecham sem
 * instalar, e a próxima checagem periódica (a cada 4h, mesmo intervalo do
 * Electron) volta a oferecer se a versão ainda for mais nova.
 *
 * Equivalente ao `DesktopUpdateBanner.tsx` do site — mesmo texto, mesma
 * decisão (instalar agora ou depois) —, só que navegável por D-pad em vez de
 * clique.
 *
 * ## Por que é um `Dialog`, e não um `Box` por cima
 *
 * Era um `Box` em tela cheia desenhado no fim da pilha do [AppTv]. Isso resolve
 * o **desenho** e não resolve o **foco**: o catálogo continuava inteiro na
 * árvore de navegação, as setas andavam pelos cards atrás do cartão e os dois
 * botões ficavam visíveis e inalcançáveis. Estar por cima não tira ninguém da
 * busca de foco.
 *
 * Um `Dialog` do Compose é uma janela de verdade. A janela de baixo perde o
 * foco de entrada, então o D-pad só alcança o que está aqui dentro — não por
 * convenção nossa, mas porque o sistema entrega as teclas a uma janela só. É
 * também o que dá o BACK de graça, por `onDismissRequest`.
 */
@Composable
fun CamadaAtualizacao() {
    val info = PonteAtualizacao.pronta ?: return
    // Dispensar vale só para ESTA versão: se uma versão ainda mais nova
    // substituir o arquivo baixado, o aviso volta a aparecer.
    var dispensada by remember(info.versionCode) { mutableStateOf(false) }
    if (dispensada) return

    val requisitorInstalar = remember(info.versionCode) { FocusRequester() }
    // Confirmação de que o cursor entrou: um `requestFocus` único falha calado
    // quando o alvo ainda não foi medido, e o cartão fica sem cursor nenhum.
    var temFoco by remember(info.versionCode) { mutableStateOf(false) }

    Dialog(
        onDismissRequest = { dispensada = true },
        properties = DialogProperties(
            // A janela ocupa a tela inteira: o véu é o mesmo de antes, desenhado
            // por nós, e o cartão continua centralizado nele.
            usePlatformDefaultWidth = false,
            dismissOnBackPress = true,
            // Televisão não tem "clicar fora"; sair é BACK ou "Agora não".
            dismissOnClickOutside = false,
        ),
    ) {
        // Insiste até o cursor entrar de fato. Mesmo motivo e mesmo formato do
        // EfeitoRestauraFoco das telas: espera o frame, tenta, confere.
        LaunchedEffect(info.versionCode) {
            var tentativas = 0
            while (!temFoco && tentativas < 24) {
                withFrameNanos { }
                runCatching { requisitorInstalar.requestFocus() }
                delay(50)
                tentativas++
            }
        }

        // Ao fechar, o cursor volta para a tela de baixo. É o mesmo pulso que a
        // CamadaDesafio usa: as telas observam `FocoBridge.pulso` e refazem a
        // própria restauração, no card de onde a pessoa saiu.
        DisposableEffect(Unit) {
            onDispose {
                runCatching { com.obaflix.tv.ui.componentes.FocoBridge.recuperar?.invoke() }
            }
        }

        Box(
            modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.72f)),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                modifier = Modifier
                    .widthIn(max = 560.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(Cores.Superficie)
                    .padding(horizontal = 40.dp, vertical = 32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    text = "Atualização disponível",
                    color = Cores.Texto,
                    fontSize = Escala.Secao,
                    fontWeight = FontWeight.Black,
                )
                Box(Modifier.height(10.dp))
                Text(
                    text = "A versão ${info.versionName} já foi baixada e está pronta para instalar.",
                    color = Cores.TextoFraco,
                    fontSize = Escala.Corpo,
                )
                Box(Modifier.height(28.dp))
                Row(
                    // Os dois botões num grupo só: a seta anda entre eles e não
                    // encontra mais nada para onde ir dentro desta janela.
                    //
                    // `onFocusChanged` vem ANTES do `focusGroup`: ele observa o
                    // que vem depois dele na cadeia. Invertido, nunca veria o
                    // grupo receber o cursor e `temFoco` ficaria falso para
                    // sempre — a espera abaixo giraria as 24 voltas à toa.
                    modifier = Modifier
                        .onFocusChanged { temFoco = it.hasFocus }
                        .focusGroup(),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    BotaoAtualizacao(
                        texto = "Atualizar agora",
                        destaque = true,
                        modifier = Modifier.focusRequester(requisitorInstalar),
                        aoClicar = { PonteAtualizacao.aoInstalar?.invoke() },
                    )
                    BotaoAtualizacao(
                        texto = "Agora não",
                        destaque = false,
                        aoClicar = { dispensada = true },
                    )
                }
            }
        }
    }
}

@Composable
private fun BotaoAtualizacao(
    texto: String,
    destaque: Boolean,
    modifier: Modifier = Modifier,
    aoClicar: () -> Unit,
) {
    val interacao = remember { MutableInteractionSource() }
    val focado by interacao.collectIsFocusedAsState()
    val escala = escalaFoco(focado, alvo = 1.05f)

    Box(
        modifier = modifier
            .escalar(escala)
            .clip(RoundedCornerShape(10.dp))
            .background(
                when {
                    destaque -> Cores.Destaque
                    focado -> Cores.FocoHalo
                    else -> Cores.SuperficieAlta
                },
            )
            .focavel(interacao = interacao, aoClicar = aoClicar)
            .padding(horizontal = 26.dp, vertical = 14.dp),
    ) {
        Text(
            text = texto,
            color = if (!destaque && focado) Color(0xFF101014) else Cores.Texto,
            fontSize = Escala.Rotulo,
            fontWeight = FontWeight.Bold,
        )
    }
}
