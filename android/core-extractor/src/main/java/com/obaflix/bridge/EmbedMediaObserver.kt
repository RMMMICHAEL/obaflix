package com.obaflix.bridge

import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import com.obaflix.ObaflixApp
import com.obaflix.player.PlayerWebViewClient
import com.obaflix.removerRequestedWithHeader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.net.URL

/**
 * Deixa a página do player externo terminar de carregar e observa a mídia final.
 *
 * Existe pelo mesmo motivo do `observeEmbedMediaInBrowser` do Electron. O POST
 * legado `/player/index.php?...&do=getVideo` responde 403 nesta variante do Fire
 * Player — o atalho morreu do lado do provedor, não do nosso. Mas a página
 * `/video/<id>` continua carregando normalmente num navegador de verdade e
 * acaba pedindo o manifesto sozinha, com a sessão que ela mesma montou.
 *
 * Então, em vez de tratar o 403 como fim da fonte, esta classe carrega essa
 * página numa WebView real e espera a mídia aparecer — exatamente o que o
 * Electron faz. Nada é forjado: nenhum token é sintetizado, o 403 continua sendo
 * 403, e a sessão/cookies são os que o próprio navegador produziu.
 *
 * A WebView vive 1×1 e transparente, nunca visível: ela não é para o usuário
 * assistir, e sim para a página fazer o que faria de qualquer jeito. É anexada
 * ao container real (e não escondida com `GONE`) porque o Chromium suspende
 * temporizadores e requisições de uma view que não é composta — foi o que
 * quebrou a primeira tentativa de fazer isto fora da árvore de views.
 */
internal object EmbedMediaObserver {

    /**
     * @return a mídia observada, ou `null` se nada apareceu dentro do prazo —
     *   e aí quem chamou mantém o erro original, que é mais informativo.
     */
    suspend fun observar(
        url: String,
        referer: String,
        ua: String,
        timeoutMs: Long,
    ): ObservedSuperflixMedia? {
        val host = ObaflixApp.hostWebView?.get() ?: run {
            ObaLog.alerta(ObaLog.Fase.PROVEDOR, "observador_sem_webview")
            return null
        }
        val container = withContext(Dispatchers.Main) { host.parent as? ViewGroup } ?: run {
            ObaLog.alerta(ObaLog.Fase.PROVEDOR, "observador_sem_container")
            return null
        }

        val playerState = ObaflixApp.playerState
        val observacao = playerState.beginSuperflixObservation()
        // A escolha de servidor já aconteceu — nós mesmos chamamos
        // /player/source. Sem confirmar isso, `observeSuperflixMedia` descarta
        // tudo com "antes_da_selecao" e a observação nunca guardaria nada.
        playerState.confirmarSelecaoSuperflix("embedplayer_fallback")

        var webView: WebView? = null
        try {
            withContext(Dispatchers.Main) {
                val wv = WebView(host.context)
                webView = wv
                wv.layoutParams = FrameLayout.LayoutParams(1, 1)
                wv.alpha = 0f
                wv.settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mediaPlaybackRequiresUserGesture = false
                    userAgentString = ua
                    allowFileAccess = false
                    allowContentAccess = false
                    setSupportMultipleWindows(false)
                    javaScriptCanOpenWindowsAutomatically = false
                }
                removerRequestedWithHeader(wv.settings, "observador-embed")
                CookieManager.getInstance().apply {
                    setAcceptCookie(true)
                    setAcceptThirdPartyCookies(wv, true)
                }
                wv.webViewClient = PlayerWebViewClient(
                    hostsNavegaveis = hostsLiberados(url),
                    onRenderGone = { _, _ ->
                        ObaLog.alerta(ObaLog.Fase.PROVEDOR, "observador_renderer_morreu")
                    },
                )
                container.addView(wv)
                wv.loadUrl(url, mapOf("Referer" to referer))
            }

            val limite = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < limite) {
                delay(200L)
                playerState.observedSuperflixMedia?.let { return it }
            }
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "observador_sem_midia",
                "ms" to timeoutMs,
            )
            return null
        } finally {
            // A WebView some junto com a resolução, em qualquer saída: ela nunca
            // fica viva por trás da reprodução.
            withContext(Dispatchers.Main) {
                webView?.let { wv ->
                    runCatching { wv.stopLoading() }
                    runCatching { (wv.parent as? ViewGroup)?.removeView(wv) }
                    runCatching { wv.destroy() }
                }
            }
            playerState.finishSuperflixObservation(observacao)
        }
    }

    /**
     * Só o host da própria página. É lista fechada pelo mesmo motivo do overlay:
     * a WebView precisa poder navegar para onde foi mandada, e para mais nada.
     */
    private fun hostsLiberados(url: String): Set<String> =
        runCatching { setOfNotNull(URL(url).host?.lowercase()) }.getOrDefault(emptySet())
}
