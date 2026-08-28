package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Button
import androidx.tv.material3.Text
import com.obaflix.bridge.PlayerExtractors
import com.obaflix.tv.BuildConfig
import com.obaflix.tv.sessao.EstadoSessao
import com.obaflix.tv.sessao.SessaoTv

/**
 * Tela de fundacao da Fase 0.
 *
 * Ela existe para provar tres coisas antes de qualquer tela de conteudo:
 *
 *  1. O :core-extractor esta realmente ligado — `PlayerExtractors.detectProvider`
 *     e o mesmo codigo que o app movel executa, nao uma copia.
 *  2. O cliente HTTP compartilhado funciona no aplicativo de TV.
 *  3. O servidor reconhece a TV e responde ao caminho de autenticacao.
 *
 * Nenhum nome real de provedor aparece na tela. As amostras abaixo contem
 * dominios reais porque e o que exercita o `detectProvider`, mas o rotulo
 * exibido e generico ("Amostra 1") e o resultado e so "reconhecido" ou "sem
 * extrator" — a mesma regra que vale para o usuario comum no player.
 *
 * Esta tela sai do aplicativo quando a Home entrar, na Fase 1.
 */

// Entradas para uma funcao pura de classificacao. Nenhuma requisicao e feita a
// elas — sao apenas texto passando por um parser de host. Os dois primeiros
// devem ser reconhecidos; o terceiro nao, para provar que a funcao discrimina
// em vez de responder sempre a mesma coisa.
private val AMOSTRAS = listOf(
    "https://playerflix.ink/filme/12345",
    "https://superflixapi.pro/filme/12345",
    "https://exemplo-desconhecido.invalid/x",
)

@Composable
fun TelaDiagnostico() {
    var estado by remember { mutableStateOf<EstadoSessao?>(null) }
    var tentativa by remember { mutableStateOf(0) }
    val foco = remember { FocusRequester() }

    LaunchedEffect(tentativa) {
        estado = null
        estado = SessaoTv.verificar()
    }
    // Nunca deixar a tela sem foco: sem isso o controle remoto nao tem por onde
    // comecar, e o usuario aperta as setas sem que nada se mova.
    LaunchedEffect(Unit) { foco.requestFocus() }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Cores.Fundo),
    ) {
        Column(modifier = Modifier.fillMaxSize().areaSegura()) {

            Text(text = "Fundacao", color = Cores.Texto, fontSize = Escala.Titulo)
            Box(Modifier.height(8.dp))
            Text(
                text = "Obaflix TV ${BuildConfig.VERSION_NAME}  ·  minSdk 21  ·  Fase 0",
                color = Cores.TextoFraco,
                fontSize = Escala.Rotulo,
            )

            Box(Modifier.height(36.dp))

            Text(text = "Modulo de extracao compartilhado", color = Cores.Texto, fontSize = Escala.Secao)
            Box(Modifier.height(12.dp))
            AMOSTRAS.forEachIndexed { indice, url ->
                // Se o modulo nao estivesse ligado, isto nem compilaria.
                val reconhecido = PlayerExtractors.detectProvider(url) != null
                // O host NAO vai para a tela: quem esta na sala nao precisa saber
                // de qual provedor se trata, e a regra vale tambem aqui.
                Linha(
                    rotulo = "Amostra ${indice + 1}",
                    valor = if (reconhecido) "reconhecido" else "sem extrator",
                    cor = if (reconhecido) Cores.Ok else Cores.TextoFraco,
                )
            }

            Box(Modifier.height(28.dp))

            Text(text = "Autenticacao", color = Cores.Texto, fontSize = Escala.Secao)
            Box(Modifier.height(12.dp))
            Linha("User-Agent", SessaoTv.userAgent, Cores.TextoFraco)
            when (val e = estado) {
                null -> Linha("Sessao", "consultando...", Cores.TextoFraco)
                is EstadoSessao.NaoPareado -> Linha(
                    "Sessao", "nao pareada — servidor respondeu ${e.httpStatus}", Cores.Alerta,
                )
                is EstadoSessao.Autenticado -> Linha("Sessao", "autenticada", Cores.Ok)
                is EstadoSessao.SemContato -> Linha("Sessao", "sem contato (${e.motivo})", Cores.Falha)
            }

            Box(Modifier.height(36.dp))

            // O Button do Compose for TV ja traz escala, brilho e borda no foco.
            // Reimplementar isso a mao daria um foco que so parece certo na
            // maquina de quem escreveu.
            Button(
                onClick = { tentativa++ },
                modifier = Modifier.focusRequester(foco),
            ) {
                Text(text = "Verificar novamente", fontSize = Escala.Corpo)
            }
        }
    }
}

@Composable
private fun Linha(rotulo: String, valor: String, cor: Color) {
    Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(
            text = rotulo,
            color = Cores.TextoFraco,
            fontSize = Escala.Corpo,
            modifier = Modifier.width(280.dp),
        )
        Text(text = valor, color = cor, fontSize = Escala.Corpo)
    }
}
