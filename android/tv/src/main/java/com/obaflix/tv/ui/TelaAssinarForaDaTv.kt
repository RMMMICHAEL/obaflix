package com.obaflix.tv.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import com.obaflix.tv.BuildConfig
import com.obaflix.tv.assinatura.LinkDeAssinatura
import com.obaflix.tv.assinatura.ResolvedorDeLinkDeAssinatura
import com.obaflix.tv.assinatura.formatarPreco
import com.obaflix.tv.assinatura.podeIrParaQr
import com.obaflix.tv.assinatura.resolvedorDaContinuacao
import com.obaflix.tv.navegacao.Camada
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.ui.componentes.BotaoTv
import com.obaflix.tv.ui.componentes.EspacoH
import com.obaflix.tv.ui.componentes.EspacoV
import kotlinx.coroutines.delay

/**
 * Continuar a assinatura fora da TV.
 *
 * Nenhum formulario aqui: nada de CPF, telefone, Pix ou cupom digitado com o
 * controle. A TV mostra para onde ir — QR e endereco curto — e a assinatura
 * termina no navegador do celular: `/planos?plano=<id>` → checkout → login ou
 * cadastro, se preciso, voltando ao mesmo plano.
 *
 * Nome e preco sao os do plano que veio do servidor na tela anterior. A tela so
 * conhece `LinkDeAssinatura`; quem produz o link e o resolvedor injetado — hoje a
 * pagina de planos, amanha um link com token opaco de handoff, sem mexer aqui.
 */
@Composable
fun TelaAssinarForaDaTv(camada: Camada.AssinarForaDaTv) {
    val resolvedor = remember(camada) { resolvedorDaContinuacao(BuildConfig.OBAFLIX_URL, camada.precoDoCheckout) }
    TelaAssinarForaDaTv(camada, resolvedor)
}

@Composable
internal fun TelaAssinarForaDaTv(camada: Camada.AssinarForaDaTv, resolvedor: ResolvedorDeLinkDeAssinatura) {
    val plano = camada.plano
    var link by remember(plano.id) { mutableStateOf<LinkDeAssinatura?>(null) }
    var resolvido by remember(plano.id) { mutableStateOf(false) }
    val voltar = remember { FocusRequester() }
    var temFoco by remember { mutableStateOf(false) }

    LaunchedEffect(plano.id) {
        // O link passa de novo pela checagem de QR aqui, e nao so no resolvedor:
        // um resolvedor futuro que errasse nao chega a desenhar credencial.
        link = runCatching { resolvedor.resolver(plano) }.getOrNull()?.takeIf { podeIrParaQr(it.urlDoQr) }
        resolvido = true
    }

    LaunchedEffect(Unit) {
        repeat(12) {
            if (temFoco || Navegacao.pilha.lastOrNull() !== camada) return@LaunchedEffect
            withFrameNanos { }
            runCatching { voltar.requestFocus() }
            delay(50)
        }
    }

    BackHandler(enabled = true) { Navegacao.voltar() }

    val margem = margemHorizontal()
    val tom = corDoTom(plano.tom)
    val preco = plano.precoDeEntrada

    Box(Modifier.fillMaxSize().background(Cores.Fundo)) {
        Box(
            Modifier.fillMaxSize().background(
                Brush.horizontalGradient(0f to tom.copy(alpha = 0.14f), 0.6f to Color.Transparent),
            ),
        )

        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = margem, vertical = margemVertical())
                .onFocusChanged { temFoco = it.hasFocus },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1.2f).padding(end = 36.dp)) {
                SeloDoPlano(texto = "Plano " + plano.nome, fundo = tom, cor = textoSobreTom(plano.tom))
                EspacoV(14.dp)
                Text(
                    text = "Continue a assinatura fora da TV",
                    color = Cores.Texto,
                    fontSize = 32.sp,
                    fontWeight = FontWeight.Black,
                    lineHeight = 38.sp,
                )
                if (preco != null) {
                    EspacoV(8.dp)
                    Text(
                        text = formatarPreco(preco.precoCentavos, preco.moeda) + " / " + preco.rotulo,
                        color = tom,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    if (plano.precos.size > 1) {
                        EspacoV(4.dp)
                        Text("Outras durações no celular.", color = Cores.TextoFraco, fontSize = 16.sp)
                    }
                }
                EspacoV(24.dp)
                Passo(1, "Aponte a câmera do celular para o QR Code.")
                EspacoV(12.dp)
                Passo(
                    2,
                    link?.let { "Ou digite no navegador do celular: " + it.enderecoLegivel }
                        ?: "Ou abra o Obaflix no navegador do celular.",
                )
                EspacoV(12.dp)
                Passo(3, "Entre com a mesma conta desta TV e conclua a assinatura.")
                EspacoV(18.dp)
                Text(
                    text = "O pagamento não é feito pela TV. Quando for confirmado, os benefícios aparecem aqui.",
                    color = Cores.TextoApagado,
                    fontSize = 15.sp,
                    lineHeight = 21.sp,
                )
                EspacoV(26.dp)
                BotaoTv(
                    // Pelo anuncio, a volta e a escolha final, nao a vitrine.
                    texto = if (camada.precoDoCheckout != null) "Voltar" else "Voltar aos planos",
                    principal = true,
                    modifier = Modifier.focusRequester(voltar),
                ) { Navegacao.voltar() }
            }

            Box(Modifier.weight(0.8f), contentAlignment = Alignment.Center) {
                val atual = link
                when {
                    !resolvido -> Text("Gerando QR Code…", color = Cores.TextoFraco, fontSize = 17.sp)

                    atual == null -> Text(
                        text = "Endereço indisponível no momento.",
                        color = Cores.TextoFraco,
                        fontSize = 17.sp,
                        textAlign = TextAlign.Center,
                    )

                    else -> {
                        val qr = lembrarQrCode(atual.urlDoQr, 600)
                        if (qr != null) {
                            Box(
                                Modifier
                                    .clip(RoundedCornerShape(16.dp))
                                    .background(Color.White)
                                    .padding(14.dp),
                            ) {
                                Image(
                                    bitmap = qr,
                                    contentDescription = "QR Code para continuar a assinatura",
                                    modifier = Modifier.size(250.dp),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Passo(numero: Int, texto: String) {
    Row(verticalAlignment = Alignment.Top) {
        Box(
            modifier = Modifier.size(30.dp).clip(RoundedCornerShape(50)).background(Cores.SuperficieAlta),
            contentAlignment = Alignment.Center,
        ) {
            Text(numero.toString(), color = Cores.Texto, fontSize = 15.sp, fontWeight = FontWeight.Bold)
        }
        EspacoH(12.dp)
        Text(
            text = texto,
            color = Cores.Texto,
            fontSize = 18.sp,
            lineHeight = 25.sp,
            modifier = Modifier.padding(top = 3.dp),
        )
    }
}
