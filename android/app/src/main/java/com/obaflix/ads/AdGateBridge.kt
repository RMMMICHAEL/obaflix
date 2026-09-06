package com.obaflix.ads

import android.app.Activity
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.obaflix.bridge.ObaLog
import java.lang.ref.WeakReference

/**
 * Ponte entre o toque do usuario na interface web e o [PlaybackAdGate].
 *
 * Por que ela existe: o aplicativo movel e uma casca WebView, entao quem sabe
 * que o usuario tocou em ASSISTIR e a pagina. Esta classe e o unico canal por
 * onde essa intencao chega ao lado nativo — e vive **so** no modulo `:app`. A
 * ponte compartilhada com a TV ([com.obaflix.bridge.ObaflixBridge], em
 * `:core-extractor`) nao foi tocada, e nem ela nem o `:tv` conhecem anuncios.
 *
 * O JS que chama isto e [AdGateScript], injetado pelo proprio aplicativo: o
 * site na Vercel e o Electron continuam exatamente como estavam.
 *
 * Nenhuma tela chama `UnityAds.show()`: a decisao inteira e do [PlaybackAdGate].
 *
 * Referencias fracas a Activity e a WebView. Uma callback tardia — anuncio
 * fechado depois de o usuario sair do aplicativo — encontra `null` e para ali,
 * sem vazar a tela nem tentar reproduzir em contexto invalido.
 */
class AdGateBridge(
    private val capability: String,
    private val gate: PlaybackAdGate,
    activity: Activity,
    webView: WebView,
) {

    private val activityRef = WeakReference(activity)
    private val webViewRef = WeakReference(webView)

    /**
     * Uma intencao real de reproducao: toque em ASSISTIR (filme), toque num
     * episodio no catalogo, ou troca de episodio dentro do proprio player
     * (proximo/anterior/selecao). Chamada por [AdGateScript], que so a dispara
     * para acoes reais do usuario.
     *
     * [origem] distingue as duas portas — `catalogo` (ancora: a navegacao espera
     * a decisao) e `player` (a rota ja trocou, com a barreira provisoria de pe).
     * A distincao e so de log: decisao e contagem sao identicas nas duas, e e
     * disso que depende a sequencia livre/livre/anuncio nao mudar conforme o
     * caminho que o usuario tomou.
     *
     * Roda na thread do JavaScript; tudo que decide anuncio e feito na principal.
     */
    @JavascriptInterface
    fun requestPlayback(capability: String, gateId: String, tipo: String, origem: String) {
        if (capability != this.capability) return
        if (!idValido(gateId)) return

        // Fronteira JS -> Kotlin: confirma que a intencao chegou ao lado nativo.
        // So tipo e origem entram no log — nada de URL, id de conteudo, numero
        // de episodio ou dado do usuario.
        val origemSegura = if (origem == "catalogo" || origem == "player") origem else "desconhecida"
        ObaLog.evento(
            PlaybackAdGate.FASE, "ads_bridge_request",
            "tipo" to tipo, "origem" to origemSegura,
        )

        val web = webViewRef.get() ?: return

        val intent = when (tipo) {
            "movie" -> PlaybackIntent.FILME
            "episode" -> PlaybackIntent.EPISODIO
            else -> {
                // Tipo desconhecido nunca segura a navegacao.
                ObaLog.alerta(PlaybackAdGate.FASE, "tipo_desconhecido")
                retomar(gateId)
                return
            }
        }

        web.post {
            val activity = activityRef.get()
            if (activity == null) {
                retomar(gateId)
                return@post
            }
            gate.requestPlayback(
                host = ActivityAdHost(activity),
                intent = intent,
                aoIniciarAnuncio = { avisar("__obaflixAdGateHold", gateId) },
                liberarReproducao = { retomar(gateId) },
            )
        }
    }

    /**
     * Canal de diagnostico do preload, chamado pelo [AdGateScript].
     *
     * Existe para que os eventos que so o JS enxerga — inicio da preparacao,
     * navegacao disparada, resultado da extracao chegando durante o anuncio,
     * liberacao, autoplay pos-liberacao — entrem na MESMA trilha do [ObaLog],
     * sob a fase `anuncio`, sem passar pelo console (que mistura ruido de
     * terceiros). So aceita o proprio capability, so registra: nenhum efeito
     * colateral. `evento` e sanitizado; nada de URL, token ou dado do usuario
     * deve ser enviado por aqui — o chamador ja se restringe a isso.
     */
    @JavascriptInterface
    fun diag(capability: String, evento: String, detalhe: String) {
        if (capability != this.capability) return
        val eventoSeguro = evento.take(48)
            .filter { it.isLetterOrDigit() || it == '_' }
            .ifEmpty { return }
        val det = detalhe.take(64).filter { it.isLetterOrDigit() || it == '_' || it == '-' }
        if (det.isEmpty()) {
            ObaLog.evento(PlaybackAdGate.FASE, eventoSeguro)
        } else {
            ObaLog.evento(PlaybackAdGate.FASE, eventoSeguro, "detalhe" to det)
        }
    }

    /** Devolve o controle ao JS para que a navegacao original prossiga. */
    private fun retomar(gateId: String) = avisar("__obaflixAdGateResume", gateId)

    private fun avisar(funcao: String, gateId: String) {
        // gateId ja passou por idValido: so letras, digitos, '_' e '-'. Nada
        // vindo da pagina entra cru dentro de um literal JS.
        if (!idValido(gateId)) return
        val web = webViewRef.get() ?: return
        web.post {
            runCatching {
                web.evaluateJavascript(
                    "if (typeof window.$funcao === 'function') window.$funcao('$gateId');",
                    null,
                )
            }
        }
    }

    private fun idValido(valor: String): Boolean =
        valor.length in 1..64 && valor.all { it.isLetterOrDigit() || it == '_' || it == '-' }
}
