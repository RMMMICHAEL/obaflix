package com.obaflix.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.obaflix.bridge.ObaLog
import com.obaflix.tv.sessao.ArmazenamentoSessao
import com.obaflix.tv.sessao.EstadoSessao
import com.obaflix.tv.sessao.PareamentoTv
import com.obaflix.tv.sessao.SessaoTv
import com.obaflix.tv.ui.TelaDiagnostico
import com.obaflix.tv.ui.TelaPareamento
import com.obaflix.tv.ui.TelaSplash
import com.obaflix.tv.ui.TemaObaflixTv

/**
 * Unica Activity do aplicativo de TV.
 *
 * Fase 1: o fluxo de entrada na conta. Ainda nao ha Home nem catalogo — de
 * proposito, porque parear precisa estar estavel antes de existir tela de
 * conteudo em cima dele.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        ObaLog.evento(
            ObaLog.Fase.SESSAO, "tv_iniciada",
            "versao" to BuildConfig.VERSION_NAME,
            "diag" to BuildConfig.DIAG_LOGS,
        )

        setContent { TemaObaflixTv { Raiz() } }
    }
}

private enum class Rota { SPLASH, PAREAMENTO, CONECTADO }

@Composable
private fun Raiz() {
    val context = LocalContext.current
    var rota by remember { mutableStateOf(Rota.SPLASH) }
    var splashPronta by remember { mutableStateOf(false) }
    var sessaoResolvida by remember { mutableStateOf(false) }

    // A checagem de sessao roda em paralelo ao splash, e nao depois dele: assim
    // os 700 ms da animacao sao os mesmos 700 ms da rede, e nao a soma dos dois.
    LaunchedEffect(Unit) {
        // Com refresh guardado, a TV tenta renovar antes de decidir qualquer
        // coisa. E o caminho normal de toda abertura depois da primeira.
        if (ArmazenamentoSessao.refreshToken(context) != null) {
            PareamentoTv.renovar(context)
        }
        val estado = SessaoTv.verificar()
        rota = if (estado is EstadoSessao.Autenticado) Rota.CONECTADO else Rota.PAREAMENTO
        sessaoResolvida = true
    }

    when {
        !splashPronta || !sessaoResolvida ->
            TelaSplash(aoTerminar = { splashPronta = true })

        rota == Rota.PAREAMENTO ->
            TelaPareamento(aoConcluir = { rota = Rota.CONECTADO })

        else -> TelaDiagnostico(aoSair = { rota = Rota.PAREAMENTO })
    }
}
