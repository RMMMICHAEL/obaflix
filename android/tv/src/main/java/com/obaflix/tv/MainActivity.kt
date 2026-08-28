package com.obaflix.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import com.obaflix.bridge.ObaLog
import com.obaflix.tv.ui.TelaDiagnostico
import com.obaflix.tv.ui.TemaObaflixTv
import com.obaflix.tv.ui.TelaSplash

/**
 * Unica Activity do aplicativo de TV.
 *
 * Fase 0: prova de fundacao. Nao ha Home nem catalogo ainda — de proposito. O
 * que precisa ficar demonstrado antes de qualquer tela de conteudo e que o
 * modulo de extracao e realmente compartilhado com o app movel e que o caminho
 * de autenticacao do servidor responde a TV. E o que a tela de diagnostico faz.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Mesma trilha de log estruturado do app movel — vem do :core-extractor.
        ObaLog.evento(
            ObaLog.Fase.SESSAO, "tv_iniciada",
            "versao" to BuildConfig.VERSION_NAME,
            "diag" to BuildConfig.DIAG_LOGS,
        )

        setContent {
            TemaObaflixTv {
                var pronto by remember { mutableStateOf(false) }
                if (pronto) TelaDiagnostico() else TelaSplash(aoTerminar = { pronto = true })
            }
        }
    }
}
