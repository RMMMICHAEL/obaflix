package com.obaflix.tv.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.Text
import com.obaflix.tv.sessao.PareamentoTv

/**
 * Entrar na conta sem digitar nada.
 *
 * A tela mostra as duas formas ao mesmo tempo, e nao uma alternativa escondida
 * atras de um botao: quem tem o celular na mao aponta a camera; quem esta com a
 * camera ruim, com o celular sem bateria ou lendo para outra pessoa usa o codigo.
 * Sao oito caracteres sem vogais e sem 0/O ou 1/I, para ninguem errar ao ditar.
 *
 * O que **nao** aparece aqui: o `deviceCode`. Ele e o segredo do pareamento e
 * fica so na memoria do aparelho. O QR leva unicamente o codigo publico.
 */
@Composable
fun TelaPareamento() {
    val context = LocalContext.current
    var convite by remember { mutableStateOf<PareamentoTv.Convite?>(null) }
    var mensagem by remember { mutableStateOf<String?>(null) }
    var tentativa by remember { mutableStateOf(0) }
    val foco = remember { FocusRequester() }

    LaunchedEffect(tentativa) {
        convite = null
        mensagem = null
        val novo = PareamentoTv.iniciar(context)
        if (novo == null) {
            mensagem = "Não foi possível falar com o Obaflix. Verifique a internet."
            return@LaunchedEffect
        }
        convite = novo
        PareamentoTv.aguardar(context, novo) { resultado ->
            when (resultado) {
                // Nada a fazer: PareamentoTv ja persistiu a sessao e publicou o
                // estado, e a raiz trocou de tela antes desta linha rodar.
                is PareamentoTv.ResultadoPoll.Aprovado -> Unit
                is PareamentoTv.ResultadoPoll.Expirado ->
                    mensagem = "O código expirou. Gere um novo para continuar."
                is PareamentoTv.ResultadoPoll.Falha ->
                    mensagem = "Conexão instável. Gere um novo código."
                is PareamentoTv.ResultadoPoll.Pendente -> Unit
            }
        }
    }

    LaunchedEffect(mensagem) { if (mensagem != null) foco.requestFocus() }

    Box(
        modifier = Modifier.fillMaxSize().background(Cores.Fundo),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier.fillMaxSize().areaSegura(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(56.dp),
        ) {
            // ── Instrução ────────────────────────────────────────────────────
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "Entre na sua conta",
                    color = Cores.Texto,
                    fontSize = Escala.Titulo,
                    fontWeight = FontWeight.Bold,
                )
                Box(Modifier.height(16.dp))
                Text(
                    text = "Aponte a câmera do celular para o código ao lado,\nou acesse o endereço abaixo e digite o código.",
                    color = Cores.TextoFraco,
                    fontSize = Escala.Corpo,
                )

                Box(Modifier.height(32.dp))

                val atual = convite
                if (atual != null) {
                    Text(text = atual.urlVerificacao, color = Cores.Texto, fontSize = Escala.Secao)
                    Box(Modifier.height(20.dp))

                    // O código é o que a pessoa lê em voz alta ou digita. Espaçado
                    // e grande porque a leitura é de três metros.
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(10.dp))
                            .background(Cores.Superficie)
                            .padding(horizontal = 28.dp, vertical = 16.dp),
                    ) {
                        Text(
                            text = atual.userCodeFormatado,
                            color = Cores.Destaque,
                            fontSize = Escala.Titulo,
                            fontWeight = FontWeight.Bold,
                        )
                    }
                } else if (mensagem == null) {
                    Text(text = "Gerando código…", color = Cores.TextoFraco, fontSize = Escala.Corpo)
                }

                mensagem?.let {
                    Box(Modifier.height(24.dp))
                    Text(text = it, color = Cores.Alerta, fontSize = Escala.Corpo)
                    Box(Modifier.height(20.dp))
                    Button(onClick = { tentativa++ }, modifier = Modifier.focusRequester(foco)) {
                        Text(text = "Gerar novo código", fontSize = Escala.Corpo)
                    }
                }
            }

            // ── QR Code ──────────────────────────────────────────────────────
            val atual = convite
            if (atual != null) {
                // Fundo branco com folga: a zona silenciosa faz parte do código,
                // e sem ela a leitura falha mesmo com o desenho correto.
                Box(
                    modifier = Modifier
                        .size(380.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(androidx.compose.ui.graphics.Color.White)
                        .padding(20.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    val imagem = lembrarQrCode(atual.urlQrCode, 660)
                    if (imagem != null) {
                        Image(
                            bitmap = imagem,
                            contentDescription = "Código QR para conectar a TV",
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            } else {
                Box(Modifier.size(380.dp))
            }
        }
    }
}
