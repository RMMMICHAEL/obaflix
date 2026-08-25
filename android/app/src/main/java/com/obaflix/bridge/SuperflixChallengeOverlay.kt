package com.obaflix.bridge

import android.annotation.SuppressLint
import android.graphics.Color
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import com.obaflix.player.PlayerWebViewClient
import com.obaflix.removerRequestedWithHeader

private const val OVERLAY_TAG = "Obaflix/Superflix"

/**
 * Mostra a pagina do SuperFlix ao usuario quando o provedor exige o Turnstile.
 *
 * Motivo de existir: o portao do SuperFlix e um desafio INTERATIVO
 * (cf_embed_challenge + widget Turnstile + submissao de formulario). Nenhuma
 * espera passiva o resolve — so uma pessoa resolve. O Electron ja funciona
 * assim: quando a extracao nativa falha, ele anexa uma WebContentsView visivel
 * a janela principal e deixa o usuario resolver o desafio e escolher o
 * servidor. Este overlay e o equivalente Android.
 *
 * Nada aqui automatiza, resolve ou contorna o desafio: a WebView apenas
 * apresenta o fluxo normal do provedor. A extracao continua observando a
 * requisicao de midia pelo PlayerState, exatamente como antes.
 */
object SuperflixChallengeOverlay {

    @Volatile
    var estaAberto: Boolean = false
        private set

    private var raiz: FrameLayout? = null
    private var webView: WebView? = null

    /**
     * User-Agent so desta WebView.
     *
     * O UA global do app termina em "ObaflixApp/1.0" e NAO pode mudar: a rota
     * /api/player/proxy usa esse token para decidir entregar os segmentos direto
     * do CDN em vez de passar pelo proxy. Trocar o UA global quebraria a
     * reproducao de todos os players. Aqui, porem, o token e um sinal claro de
     * automacao para o Cloudflare, entao esta WebView usa o UA padrao do sistema
     * sem os marcadores de WebView.
     */
    private fun uaLimpo(webView: WebView): String =
        WebSettings.getDefaultUserAgent(webView.context)
            .replace("; wv", "")
            .replace(" wv)", ")")
            .replace("Version/4.0 ", "")

    /**
     * @param host WebView principal; serve de contexto e de ancora no container.
     */
    @SuppressLint("SetJavaScriptEnabled")
    fun abrir(host: WebView, embedUrl: String) {
        host.post {
            if (estaAberto) return@post
            val container = host.parent as? ViewGroup ?: run {
                Log.w(OVERLAY_TAG, "[overlay] sem container para anexar; desafio nao pode ser exibido")
                return@post
            }

            val raizNova = FrameLayout(host.context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                setBackgroundColor(Color.BLACK)
                // Sem isto, toques atravessariam para a WebView principal atras.
                isClickable = true
            }

            val wv = WebView(host.context)
            wv.layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
            wv.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                useWideViewPort = true
                loadWithOverviewMode = true
                userAgentString = uaLimpo(wv)
            }

            removerRequestedWithHeader(wv.settings, "overlay-desafio")

            // O Turnstile grava cf_clearance como cookie de terceiros dentro do iframe.
            CookieManager.getInstance().apply {
                setAcceptCookie(true)
                setAcceptThirdPartyCookies(wv, true)
            }

            // Reusa o cliente principal: ele ja observa a midia via PlayerState,
            // remove o CSP do documento e trata o CDN. onPageReady fica nulo de
            // proposito — o shim da bridge nao deve entrar na pagina do provedor.
            wv.webViewClient = PlayerWebViewClient(
                onPageReady = null,
                onRenderGone = { _, _ ->
                    Log.w(OVERLAY_TAG, "[overlay] renderer morreu durante o desafio; fechando")
                    fechar()
                },
            )

            val aviso = TextView(host.context).apply {
                text = "Conclua a verificacao e escolha um servidor para assistir."
                setTextColor(Color.WHITE)
                textSize = 14f
                gravity = Gravity.CENTER
                setPadding(48, 36, 48, 36)
                setBackgroundColor(Color.parseColor("#CC000000"))
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.TOP,
                )
            }

            val fechar = Button(host.context).apply {
                text = "✕"
                setTextColor(Color.WHITE)
                setBackgroundColor(Color.parseColor("#E50914"))
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.TOP or Gravity.END,
                ).apply { setMargins(0, 24, 24, 0) }
                setOnClickListener {
                    Log.d(OVERLAY_TAG, "[overlay] fechado pelo usuario")
                    fechar()
                }
            }

            raizNova.addView(wv)
            raizNova.addView(aviso)
            raizNova.addView(fechar)
            container.addView(raizNova)

            raiz = raizNova
            webView = wv
            estaAberto = true

            Log.d(OVERLAY_TAG, "[overlay] aberto para o desafio interativo")
            wv.loadUrl(embedUrl)
        }
    }

    /** Persiste cf_clearance no disco para o desafio nao se repetir a cada episodio. */
    fun persistirCookies() {
        runCatching { CookieManager.getInstance().flush() }
            .onSuccess { Log.d(OVERLAY_TAG, "[overlay] cookies persistidos (flush)") }
    }

    fun fechar() {
        val wv = webView
        val r = raiz
        if (wv == null && r == null) {
            estaAberto = false
            return
        }
        // post na propria view garante a thread de UI sem depender de Activity.
        (r ?: wv)?.post {
            persistirCookies()
            runCatching {
                (r?.parent as? ViewGroup)?.removeView(r)
                wv?.stopLoading()
                wv?.destroy()
            }
            raiz = null
            webView = null
            estaAberto = false
            Log.d(OVERLAY_TAG, "[overlay] encerrado")
        }
    }
}
