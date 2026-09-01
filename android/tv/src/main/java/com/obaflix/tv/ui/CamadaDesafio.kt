package com.obaflix.tv.ui

import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.viewinterop.AndroidView
import com.obaflix.ObaflixApp
import com.obaflix.bridge.ObaLog
import com.obaflix.bridge.SuperflixChallengeOverlay
import java.lang.ref.WeakReference

/**
 * Ponte entre a extracao e a interface, para o desafio interativo.
 *
 * `FontesTv` roda fora da composicao e precisa que uma WebView exista **antes**
 * de o extrator pedir o desafio. Este objeto e o unico canal: a extracao liga,
 * a moldura observa e monta a camada, e a extracao espera a ancora aparecer.
 */
object PonteDesafio {
    /** Ligado enquanto uma fonte que exige desafio esta sendo resolvida. */
    var ativo by mutableStateOf(false)

    /** A ancora ja existe e o overlay pode se pendurar nela? */
    val ancoraPronta: Boolean get() = ObaflixApp.hostWebView?.get() != null
}

/**
 * Camada do desafio "nao sou robo".
 *
 * A televisao nao tem WebView nenhuma — o player e nativo. Mas o fluxo do
 * SuperFlix, que ja funciona no Electron e no aplicativo movel, precisa de uma:
 * `SuperflixExtractor` abre o `SuperflixChallengeOverlay`, que se pendura no
 * `parent` de uma WebView hospedeira e deixa a pessoa resolver o Turnstile e
 * escolher o servidor. A captura da midia final e do `PlayerWebViewClient`, a
 * mesma dos outros ambientes.
 *
 * Esta camada existe so para fornecer essa hospedeira. A WebView que ela cria e
 * uma **ancora de 1 pixel**: nao carrega nada, nao aparece, nao navega. Quem
 * ocupa a tela e o overlay, adicionado dentro do FrameLayout abaixo — que e
 * nosso e ocupa a tela inteira, entao o overlay nasce em tela cheia sem depender
 * da arvore de views do Compose.
 *
 * Nenhum extrator novo foi escrito. O que faltava na TV era o contexto.
 */
@Composable
fun CamadaDesafio() {
    // A referencia e fraca e vive so enquanto esta camada estiver composta. Sai
    // no onDispose, junto com a WebView — sem isso a Activity ficaria presa por
    // um campo estatico depois de a tela morrer.
    DisposableEffect(Unit) {
        onDispose {
            SuperflixChallengeOverlay.fechar()
            ObaflixApp.hostWebView = null
            // O cursor tem de voltar para o Compose; sem o pulso ele fica na
            // WebView que acabou de sumir e o D-pad para de responder.
            com.obaflix.tv.ui.componentes.FocoBridge.recuperar?.invoke()
            ObaLog.evento(ObaLog.Fase.PROVEDOR, "tv_desafio_encerrado")
        }
    }

    // BACK aqui e a saida de emergencia: se o overlay ja tratou, ele nem chega;
    // se por algum motivo nao houver overlay, desliga a camada em vez de deixar
    // a pessoa numa tela preta sem resposta.
    BackHandler(enabled = true) {
        if (SuperflixChallengeOverlay.estaAberto) {
            SuperflixChallengeOverlay.fechar()
        } else {
            PonteDesafio.ativo = false
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { contexto ->
                FrameLayout(contexto).apply {
                    val ancora = WebView(contexto).apply {
                        // Nada de JavaScript, arquivo ou conteudo: esta WebView
                        // nunca carrega pagina. Ela so existe para o overlay ter
                        // um `parent` em que se pendurar.
                        settings.javaScriptEnabled = false
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        isFocusable = false
                        isFocusableInTouchMode = false
                    }
                    addView(ancora, FrameLayout.LayoutParams(1, 1))
                    ObaflixApp.hostWebView = WeakReference(ancora)
                    ObaLog.evento(ObaLog.Fase.PROVEDOR, "tv_desafio_ancora_pronta")
                }
            },
            onRelease = { raiz ->
                // Ordem importa: tira o overlay antes de destruir a ancora, senao
                // ele ficaria com um `parent` morto.
                SuperflixChallengeOverlay.fechar()
                (0 until raiz.childCount)
                    .map { raiz.getChildAt(it) }
                    .filterIsInstance<WebView>()
                    .forEach { runCatching { it.destroy() } }
                raiz.removeAllViews()
            },
        )
    }
}
