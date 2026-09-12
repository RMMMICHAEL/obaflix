package com.obaflix.ads

import android.app.Activity
import android.webkit.JavascriptInterface
import android.webkit.WebView
import com.obaflix.bridge.ObaLog
import java.lang.ref.WeakReference
import org.json.JSONObject

/**
 * A ponte entre a interface web e o SDK de anuncio. Uma capacidade, e nada alem.
 *
 * ## Por que ela e tao pequena
 *
 * A versao anterior desta ponte (`AdGateBridge`, na branch
 * `local/obaflix-current`) recebia a *intencao de reproduzir* e decidia, no
 * aparelho, se havia anuncio. Esta recebe uma ordem — "exiba o anuncio deste
 * desafio" — e devolve o que aconteceu. Quem decide e o servidor, em
 * `/api/playback/authorize`; quem libera a reproducao e `/api/player/fontes`,
 * consumindo uma concessao que so o servidor emite.
 *
 * A consequencia pratica: **nada que o JavaScript faca aqui libera reproducao**.
 * Chamar `mostrarAnuncio` com um `desafioId` inventado exibe um anuncio e
 * devolve sucesso — e `/api/ads/complete` recusa o desafio inexistente. O ganho
 * do atacante e ter visto um anuncio.
 *
 * ## Superficie
 *
 * Um metodo `@JavascriptInterface`, protegido pelo mesmo `capability` aleatorio
 * por sessao que a ponte principal do aplicativo ja exige. Nao e acesso generico
 * do WebView ao nativo: e esta capacidade, com esta assinatura.
 *
 * Referencias fracas a Activity e a WebView. Uma callback tardia — anuncio
 * fechado depois de o usuario sair do aplicativo — encontra `null` e para ali,
 * sem vazar a tela nem tentar reproduzir em contexto invalido.
 */
class AdsBridge(
    private val capability: String,
    private val provider: InterstitialAdProvider,
    activity: Activity,
    webView: WebView,
) {

    private val activityRef = WeakReference(activity)
    private val webViewRef = WeakReference(webView)

    /** Impede duas exibicoes simultaneas. O SDK nao gosta, e o usuario menos. */
    @Volatile
    private var exibindo = false

    companion object {
        /** O nome que o JS ve. Ver `AdsScript`. */
        const val NOME_JS = "ObaflixAdsNativo"
        private const val FASE = "ADS"
    }

    /**
     * Exibe o interstitial para este desafio.
     *
     * [desafioId] vem do servidor e volta inalterado na conclusao — e o que
     * amarra a resposta ao pedido. Uma callback tardia de um desafio anterior
     * chega ao JS com o id antigo e e descartada la.
     *
     * Roda na thread do JavaScript; tudo que toca SDK e UI vai para a principal.
     */
    @JavascriptInterface
    fun mostrarAnuncio(capability: String, desafioId: String) {
        if (capability != this.capability) return
        if (!idValido(desafioId)) return

        val web = webViewRef.get() ?: return

        web.post {
            val activity = activityRef.get()
            if (activity == null || activity.isFinishing || activity.isDestroyed) {
                // Sem tela nao ha onde exibir. Responder "nao exibido" e melhor
                // do que silencio: o modal do JS sai do ar em vez de ficar preso.
                responder(desafioId, concluido = false)
                return@post
            }

            if (exibindo) {
                ObaLog.alerta(FASE, "ads_exibicao_concorrente")
                responder(desafioId, concluido = false)
                return@post
            }
            exibindo = true

            if (!provider.pronto) {
                // Sem inventario carregado. Pede o proximo e devolve "nao
                // exibido" — o usuario nao fica esperando um anuncio que nao vem.
                //
                // Aqui o fail-open e do ANUNCIO, nao da reproducao: o servidor
                // continua sem emitir concessao, entao a sessao nao abre. O que
                // se perde e a receita daquela exibicao, nunca o controle.
                provider.preload()
                exibindo = false
                ObaLog.evento(FASE, "ads_sem_inventario")
                responder(desafioId, concluido = false)
                return@post
            }

            ObaLog.evento(FASE, "ads_show_pedido")

            provider.show(
                host = ActivityAdHost(activity),
                aoAbrir = { ObaLog.evento(FASE, "ads_aberto") },
                aoTerminar = { resultado ->
                    exibindo = false
                    // Ja pede o proximo: o usuario provavelmente vai assistir
                    // outra coisa, e carregar agora tira o atraso do caminho.
                    provider.preload()

                    val exibiu = resultado == AdShowOutcome.EXIBIDO
                    ObaLog.evento(FASE, "ads_terminado", "exibido" to exibiu)
                    responder(desafioId, concluido = exibiu)
                },
            )
        }
    }

    /**
     * Devolve o resultado ao JavaScript.
     *
     * Os dois valores vao por `JSONObject.quote`, e nao por interpolacao: o
     * `desafioId` e validado antes, mas montar JavaScript com concatenacao e o
     * habito que um dia encontra uma entrada que ninguem validou.
     */
    private fun responder(desafioId: String, concluido: Boolean) {
        val web = webViewRef.get() ?: return
        val id = JSONObject.quote(desafioId)
        web.post {
            web.evaluateJavascript(
                "window.__obaflixAnuncioConcluido && window.__obaflixAnuncioConcluido($id, $concluido);",
                null,
            )
        }
    }

    /** Opaco, curto e do alfabeto que o servidor gera (base64url). */
    private fun idValido(id: String): Boolean =
        id.isNotEmpty() && id.length <= 64 && id.all { it.isLetterOrDigit() || it == '-' || it == '_' }
}
