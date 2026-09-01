package com.obaflix.bridge

import android.annotation.SuppressLint
import android.graphics.Color
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.view.KeyEvent
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import com.obaflix.player.PlayerWebViewClient
import com.obaflix.removerRequestedWithHeader


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

    /**
     * Hosts que a pagina do desafio pode navegar.
     *
     * O provedor troca de dominio de tempos em tempos — `.pro`, depois `.sbs`,
     * e em campo apareceu `.beer`. Por isso a lista casa pelo prefixo do
     * dominio, e nao por sufixo fixo: o que identifica e `superflixapi`, e a
     * terminacao muda sem aviso. `challenges.cloudflare.com` entra porque o
     * widget do Turnstile vive la; sem ele nao ha o que confirmar.
     */
    /**
     * Origem que a pagina do provedor enxerga como quem a esta embutindo.
     *
     * O documento e carregado com esta base, entao o iframe sai com Referer do
     * nosso site — o mesmo que o navegador manda no site e no Electron.
     */
    private val BASE_DO_APLICATIVO = com.obaflix.core.BuildConfig.OBAFLIX_URL

    /**
     * Documento minimo que **embute** o provedor, em vez de navegar ate ele.
     *
     * Carregar o endereco direto fazia o provedor mostrar "Visualizacao
     * Externa — este conteudo e protegido", com um codigo de incorporacao e
     * nenhum desafio para resolver: aberto como documento principal, ele se
     * recusa a servir o player. E coerente, e o site e o Electron nunca
     * esbarraram nisso porque sempre o carregaram dentro de um `<iframe>`.
     *
     * Este HTML e a mesma coisa que o CustomPlayer monta: iframe em tela cheia,
     * `referrerpolicy=origin-when-cross-origin` para o provedor ver de onde vem,
     * a mesma lista de `allow`, e **sem sandbox** — o desafio precisa de scripts
     * e de cookie de terceiro para rodar.
     *
     * O iframe e sub-frame, entao a navegacao dele nao passa pela recusa de
     * frame principal do PlayerWebViewClient; o frame principal e a nossa
     * propria base.
     */
    private fun documentoComIframe(embedUrl: String): String {
        // Só aspas: o endereço vem do nosso backend e vai para dentro de um
        // atributo. Escapar impede que um valor inesperado feche o atributo.
        val src = embedUrl.replace("&", "&amp;").replace("\"", "&quot;")
        return """
            <!DOCTYPE html>
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}
            iframe{border:0;width:100%;height:100%;display:block}</style></head>
            <body><iframe src="$src"
              referrerpolicy="origin-when-cross-origin"
              allow="autoplay *; encrypted-media *; picture-in-picture *; fullscreen *; clipboard-write *; accelerometer *; gyroscope *; web-share *"
              allowfullscreen webkitallowfullscreen></iframe></body></html>
        """.trimIndent()
    }

    private val HOSTS_DO_DESAFIO = setOf(
        "superflixapi.pro",
        "superflixapi.sbs",
        "superflixapi.beer",
        "challenges.cloudflare.com",
    )

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
    /**
     * O User-Agent com que a midia foi obtida.
     *
     * O CDN deste provedor amarra o link ao par User-Agent/Referer que o gerou.
     * A WebView do desafio navega com o UA do sistema limpo; o cliente HTTP da
     * extracao usa outro, com o marcador do aplicativo. Pedir a playlist com o
     * segundo depois de te-la obtido com o primeiro devolve 403 — foi
     * exatamente o que aconteceu em campo. Quem for reproduzir precisa deste.
     */
    @Volatile
    var uaEmUso: String? = null
        private set

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
                ObaLog.alerta(ObaLog.Fase.PROVEDOR, "overlay_sem_container")
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
                userAgentString = uaLimpo(wv).also { uaEmUso = it }
                // A pagina e de terceiro: nada de alcancar o disco do aparelho.
                allowFileAccess = false
                allowContentAccess = false
                // Sem janela nova. `window.open` e `target=_blank` viram
                // navegacao de frame principal, que o PlayerWebViewClient ja
                // recusa — entao nao ha caminho para abrir o navegador do
                // sistema a partir daqui.
                setSupportMultipleWindows(false)
                javaScriptCanOpenWindowsAutomatically = false
            }

            // Download e sempre recusa. A pagina do provedor nao tem por que
            // baixar arquivo nenhum, e um "salvar como" a partir dela sairia do
            // controle do aplicativo.
            wv.setDownloadListener { url, _, _, _, _ ->
                ObaLog.alerta(
                    ObaLog.Fase.PROVEDOR, "overlay_download_bloqueado",
                    "host" to ObaLog.host(url),
                )
            }

            // Nenhum `addJavascriptInterface` aqui, de proposito: a ponte nativa
            // pertence ao documento do aplicativo, nunca ao do provedor.

            // Controle remoto. Sem isto a WebView nao recebe foco na televisao e
            // as setas nao andam pelo conteudo — o desafio fica visivel e
            // inalcancavel.
            wv.isFocusable = true
            wv.isFocusableInTouchMode = true

            // VOLTAR recua no historico enquanto houver para onde, e so entao
            // fecha. E o que impede ficar preso dentro do iframe de um servidor
            // sem caminho de saida.
            wv.setOnKeyListener { _, codigo, evento ->
                // Toda tecla vira linha de log, para o momento exato de um OK
                // poder ser cruzado com a navegacao e a captura que vierem
                // depois. So no ACTION_UP, senao cada toque sairia duas vezes.
                if (evento.action == KeyEvent.ACTION_UP) {
                    val nome = when (codigo) {
                        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER,
                        KeyEvent.KEYCODE_NUMPAD_ENTER -> "OK"
                        KeyEvent.KEYCODE_DPAD_UP -> "CIMA"
                        KeyEvent.KEYCODE_DPAD_DOWN -> "BAIXO"
                        KeyEvent.KEYCODE_DPAD_LEFT -> "ESQUERDA"
                        KeyEvent.KEYCODE_DPAD_RIGHT -> "DIREITA"
                        KeyEvent.KEYCODE_BACK -> "VOLTAR"
                        else -> null
                    }
                    if (nome != null) {
                        ObaLog.evento(ObaLog.Fase.PROVEDOR, "overlay_tecla", "tecla" to nome)
                    }
                }
                if (codigo != KeyEvent.KEYCODE_BACK) return@setOnKeyListener false
                // Consome tambem o ACTION_DOWN: deixar so o UP passar faria a
                // Activity tratar o mesmo toque por baixo.
                if (evento.action != KeyEvent.ACTION_UP) return@setOnKeyListener true
                if (wv.canGoBack()) {
                    wv.goBack()
                } else {
                    ObaLog.evento(ObaLog.Fase.PROVEDOR, "overlay_fechado", "por" to "voltar")
                    fechar()
                }
                true
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
                // So os hosts do provedor. Sem isto o proprio endereco pedido
                // era recusado como "navegacao externa" e a tela ficava branca.
                hostsNavegaveis = HOSTS_DO_DESAFIO,
                onPageReady = null,
                onRenderGone = { _, _ ->
                    ObaLog.alerta(ObaLog.Fase.PROVEDOR, "overlay_renderer_morreu")
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
                    ObaLog.evento(ObaLog.Fase.PROVEDOR, "overlay_fechado", "por" to "usuario")
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

            ObaLog.evento(ObaLog.Fase.PROVEDOR, "overlay_aberto")
            wv.requestFocus()
            // Enquadrado, e nao navegado direto — ver documentoComIframe.
            wv.loadDataWithBaseURL(
                BASE_DO_APLICATIVO,
                documentoComIframe(embedUrl),
                "text/html",
                "utf-8",
                null,
            )
        }
    }

    /** Persiste cf_clearance no disco para o desafio nao se repetir a cada episodio. */
    fun persistirCookies() {
        runCatching { CookieManager.getInstance().flush() }
            .onSuccess { ObaLog.evento(ObaLog.Fase.PROVEDOR, "overlay_cookies_persistidos") }
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
            ObaLog.evento(ObaLog.Fase.PROVEDOR, "overlay_encerrado")
        }
    }
}
