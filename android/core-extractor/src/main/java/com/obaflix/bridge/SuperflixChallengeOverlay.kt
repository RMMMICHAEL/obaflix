package com.obaflix.bridge

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
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
     * O documento que **embute** o provedor nao e mais montado em memoria.
     *
     * Carregar o endereco do provedor direto no frame principal continua fora
     * de questao — ele responde "Visualizacao Externa — este conteudo e
     * protegido". O iframe segue sendo iframe; o que mudou e de onde vem o
     * documento que o contem: `SuperflixWrapperHost` o serve por uma origem
     * https local e estavel, em vez de `loadDataWithBaseURL`, que por baixo e
     * uma navegacao `data:` e por isso nao e contexto seguro. Ver a
     * documentacao de SuperflixWrapperHost para o porque de isso derrubar o
     * desafio.
     */
    private val HOSTS_DO_DESAFIO = setOf(
        "superflixapi.pro",
        "superflixapi.sbs",
        "superflixapi.beer",
        "challenges.cloudflare.com",
    )

    /**
     * Hosts que esta WebView pode navegar no frame principal.
     *
     * Alem do provedor, a origem local do wrapper — que e quem o frame
     * principal de fato carrega. Nao resolve em DNS e nunca sai do aparelho.
     */
    private val HOSTS_NAVEGAVEIS = HOSTS_DO_DESAFIO + SuperflixWrapperHost.HOST

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

    /**
     * Versão do pacote da Android System WebView deste aparelho.
     *
     * `getCurrentWebViewPackage` só existe da API 26 em diante; abaixo disso não
     * há como perguntar, e o log diz isso em vez de estourar.
     */
    private fun versaoWebView(): String {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) return "indisponivel"
        return runCatching {
            WebView.getCurrentWebViewPackage()?.versionName ?: "desconhecida"
        }.getOrDefault("indisponivel")
    }

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

            // A raiz trata o controle remoto, e nao a WebView.
            //
            // `WebView` e um `ViewGroup`: `dispatchKeyEvent` desce primeiro para
            // o filho com foco — a view interna do renderizador — e o
            // `OnKeyListener` da propria WebView so seria chamado se o evento
            // voltasse sem ser consumido. Com o conteudo focado ele nunca
            // voltava, e era por isso que as setas "nao funcionavam": o ponteiro
            // nem chegava a ser avisado delas. A raiz ve o evento antes de
            // qualquer descida, entao aqui a decisao e nossa.
            val raizNova = object : FrameLayout(host.context) {
                var aoTeclar: ((KeyEvent) -> Boolean)? = null

                override fun dispatchKeyEvent(event: KeyEvent): Boolean =
                    aoTeclar?.invoke(event) == true || super.dispatchKeyEvent(event)
            }.apply {
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

            removerRequestedWithHeader(wv.settings, "overlay-desafio")

            // O Turnstile grava cf_clearance como cookie de TERCEIRO, dentro do
            // iframe. Sem aceitar cookie de terceiro a validacao nunca fixa e o
            // desafio volta a cada tentativa — que e exatamente o que os logs
            // vinham mostrando, com cf_clearance nunca aparecendo.
            CookieManager.getInstance().apply {
                setAcceptCookie(true)
                setAcceptThirdPartyCookies(wv, true)
            }

            // Capacidades reais deste aparelho, registradas no momento em que o
            // desafio abre. É a diferença entre "o Turnstile foi recusado" e "o
            // Turnstile nunca teve como rodar aqui": a versão do pacote da
            // WebView decide quais primitivas o widget encontra.
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "overlay_capacidades",
                "webview" to versaoWebView(),
                "js" to wv.settings.javaScriptEnabled,
                "dom_storage" to wv.settings.domStorageEnabled,
                "cookies" to CookieManager.getInstance().acceptCookie(),
                "cookies_terceiros" to CookieManager.getInstance().acceptThirdPartyCookies(wv),
                "ua_termina_em" to (uaEmUso?.takeLast(28) ?: "-"),
            )

            // Erro de JavaScript dentro do widget não aparece em lugar nenhum
            // sem isto — e é o sinal mais direto de que o desafio não conseguiu
            // executar. Só nível, origem por host e um trecho curto da mensagem;
            // nenhum argumento de console é registrado por inteiro.
            wv.webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(cm: ConsoleMessage): Boolean {
                    if (cm.messageLevel() == ConsoleMessage.MessageLevel.ERROR ||
                        cm.messageLevel() == ConsoleMessage.MessageLevel.WARNING
                    ) {
                        ObaLog.alerta(
                            ObaLog.Fase.PROVEDOR, "overlay_console",
                            "nivel" to cm.messageLevel().name,
                            "origem" to ObaLog.host(cm.sourceId()),
                            "msg" to cm.message().take(140),
                        )
                    }
                    return true
                }
            }

            // Reusa o cliente principal: e ele que observa a midia pelo
            // PlayerState, marca a escolha de servidor em /player/source, mede o
            // status da resposta do CDN e trata os hosts liberados. Sem cliente
            // nenhum, esta WebView carregava a pagina e nao contava nada a
            // ninguem. onPageReady fica nulo de proposito — o shim da bridge nao
            // entra na pagina do provedor.
            wv.webViewClient = PlayerWebViewClient(
                // So os hosts do provedor e a origem local do wrapper. Sem isto
                // o proprio endereco pedido era recusado como "navegacao
                // externa" e a tela ficava branca.
                hostsNavegaveis = HOSTS_NAVEGAVEIS,
                // Quem serve o documento que embute o provedor.
                interceptadorLocal = SuperflixWrapperHost::interceptar,
                onRequestDiagnostic = { host, path, method, principal, temReferer, temOrigin, temXrw ->
                    val h = host.lowercase()

                    val relevante =
                        h.contains("superflixapi.") ||
                            h == "challenges.cloudflare.com" ||
                            h.endsWith(".challenges.cloudflare.com")

                    if (relevante) {
                        val rota = when {
                            path.startsWith("/cdn-cgi/challenge-platform") ->
                                "/cdn-cgi/challenge-platform/*"

                            path.startsWith("/cdn-cgi/") ->
                                "/cdn-cgi/*"

                            path.startsWith("/player/bootstrap") ->
                                "/player/bootstrap"

                            path.startsWith("/player/source") ->
                                "/player/source"

                            path.startsWith("/player/redirect") ->
                                "/player/redirect"

                            path.startsWith("/serie/") ->
                                "/serie/*"

                            path.startsWith("/filme/") ->
                                "/filme/*"

                            h.contains("challenges.cloudflare.com") ->
                                "/cloudflare/*"

                            else ->
                                "/outro"
                        }

                        ObaLog.evento(
                            ObaLog.Fase.PROVEDOR,
                            "overlay_request",
                            "host" to h,
                            "rota" to rota,
                            "metodo" to method,
                            "principal" to principal,
                            "referer" to temReferer,
                            "origin" to temOrigin,
                            "xrw" to temXrw,
                        )
                    }
                },
                onPageReady = null,
                onRenderGone = { _, _ ->
                    ObaLog.alerta(ObaLog.Fase.PROVEDOR, "overlay_renderer_morreu")
                    fechar()
                },
            )

            // Nenhum `addJavascriptInterface` aqui, de proposito: a ponte nativa
            // pertence ao documento do aplicativo, nunca ao do provedor.

            // Controle remoto. Sem isto a WebView nao recebe foco na televisao e
            // as setas nao andam pelo conteudo — o desafio fica visivel e
            // inalcancavel.
            wv.isFocusable = true
            wv.isFocusableInTouchMode = true

            // ── Ponteiro virtual ──────────────────────────────────────
            //
            // O widget do desafio vive num iframe de outra origem, dentro do
            // iframe do provedor, dentro do nosso documento. A navegacao por
            // setas da WebView nao atravessa esse aninhamento: o quadradinho
            // fica visivel e inalcancavel pelo controle.
            //
            // Em vez de injetar JavaScript na pagina de terceiro — que e
            // exatamente o que a blindagem deste overlay existe para evitar —,
            // as setas movem um ponteiro nosso e o OK entrega um toque real na
            // coordenada. Do lado da pagina e um dedo; do nosso lado nao ha uma
            // linha de script dentro do documento dela.
            val ponteiro = View(host.context).apply {
                val d = (host.context.resources.displayMetrics.density * 22).toInt()
                layoutParams = FrameLayout.LayoutParams(d, d)
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(Color.parseColor("#66FFFFFF"))
                    setStroke((host.context.resources.displayMetrics.density * 2).toInt(), Color.WHITE)
                }
                isClickable = false
                isFocusable = false
            }

            fun nomeDaTecla(codigo: Int): String? = when (codigo) {
                KeyEvent.KEYCODE_DPAD_LEFT -> "ESQUERDA"
                KeyEvent.KEYCODE_DPAD_RIGHT -> "DIREITA"
                KeyEvent.KEYCODE_DPAD_UP -> "CIMA"
                KeyEvent.KEYCODE_DPAD_DOWN -> "BAIXO"
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER,
                KeyEvent.KEYCODE_NUMPAD_ENTER -> "OK"
                KeyEvent.KEYCODE_BACK -> "VOLTAR"
                else -> null
            }

            // Segurar a seta anda mais: um toque ajusta, segurar atravessa a
            // tela. Sem isso, cruzar mil pixels de 24 em 24 seria penoso.
            fun passoDe(repeticao: Int) =
                24f * host.context.resources.displayMetrics.density *
                    (1 + minOf(repeticao, 12) * 0.6f)

            var ultimoRelatoDoPonteiro = 0L

            raizNova.aoTeclar = fun(evento: KeyEvent): Boolean {
                val nome = nomeDaTecla(evento.keyCode) ?: return false

                // VOLTAR recua no historico enquanto houver para onde, e so
                // entao fecha. E o que impede ficar preso dentro do iframe de um
                // servidor sem caminho de saida.
                if (nome == "VOLTAR") {
                    // Consome tambem o ACTION_DOWN: deixar so o UP passar faria a
                    // Activity tratar o mesmo toque por baixo.
                    if (evento.action != KeyEvent.ACTION_UP) return true
                    ObaLog.evento(ObaLog.Fase.PROVEDOR, "overlay_tecla", "tecla" to nome)
                    if (wv.canGoBack()) {
                        wv.goBack()
                    } else {
                        ObaLog.evento(ObaLog.Fase.PROVEDOR, "overlay_fechado", "por" to "voltar")
                        fechar()
                    }
                    return true
                }

                if (evento.action != KeyEvent.ACTION_DOWN) return true

                if (nome == "OK") {
                    val x = ponteiro.x + ponteiro.width / 2f
                    val y = ponteiro.y + ponteiro.height / 2f
                    ObaLog.evento(
                        ObaLog.Fase.PROVEDOR, "overlay_tecla",
                        "tecla" to nome, "x" to x.toInt(), "y" to y.toInt(),
                    )
                    val agora = SystemClock.uptimeMillis()
                    var aceito = true
                    listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP).forEach { acao ->
                        val toque = MotionEvent.obtain(agora, agora + 40, acao, x, y, 0)
                        aceito = wv.dispatchTouchEvent(toque) && aceito
                        toque.recycle()
                    }
                    // "aceito" diz se a WebView recebeu o toque sintetico. Sem
                    // este campo nao ha como separar "o OK nao chegou" de "o OK
                    // chegou e a pagina ignorou".
                    ObaLog.evento(
                        ObaLog.Fase.PROVEDOR, "overlay_toque",
                        "x" to x.toInt(), "y" to y.toInt(), "aceito" to aceito,
                    )
                    return true
                }

                val passo = passoDe(evento.repeatCount)
                when (nome) {
                    "ESQUERDA" -> ponteiro.translationX -= passo
                    "DIREITA" -> ponteiro.translationX += passo
                    "CIMA" -> ponteiro.translationY -= passo
                    "BAIXO" -> ponteiro.translationY += passo
                }
                // Nao deixa o ponteiro sair da tela.
                ponteiro.translationX = ponteiro.translationX
                    .coerceIn(0f, (wv.width - ponteiro.width).toFloat())
                ponteiro.translationY = ponteiro.translationY
                    .coerceIn(0f, (wv.height - ponteiro.height).toFloat())

                // Foco de DOM dentro de iframe de outra origem nao e observavel
                // por ninguem de fora dele; nesta camada quem faz as vezes de
                // foco e a posicao do ponteiro. Uma linha por repeticao afogaria
                // o log, entao sai a primeira e depois uma a cada 250 ms.
                val agora = SystemClock.uptimeMillis()
                if (evento.repeatCount == 0 || agora - ultimoRelatoDoPonteiro > 250L) {
                    ultimoRelatoDoPonteiro = agora
                    ObaLog.evento(
                        ObaLog.Fase.PROVEDOR, "servidor_focado",
                        "tecla" to nome,
                        "x" to (ponteiro.x + ponteiro.width / 2f).toInt(),
                        "y" to (ponteiro.y + ponteiro.height / 2f).toInt(),
                    )
                }
                return true
            }

            val aviso = TextView(host.context).apply {
                text = "Setas movem o ponteiro · OK toca · VOLTAR sai"
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
            raizNova.addView(ponteiro)
            raizNova.addView(aviso)
            // Comeca no meio da tela, onde o desafio costuma nascer.
            wv.post {
                ponteiro.translationX = (wv.width - ponteiro.width) / 2f
                ponteiro.translationY = (wv.height - ponteiro.height) / 2f
            }
            raizNova.addView(fechar)
            container.addView(raizNova)

            raiz = raizNova
            webView = wv
            estaAberto = true

            ObaLog.evento(ObaLog.Fase.PROVEDOR, "overlay_aberto")
            wv.requestFocus()
            // Enquadrado, e nao navegado direto — e servido por origem https
            // local, e nao montado em memoria. Ver SuperflixWrapperHost.
            val wrapper = SuperflixWrapperHost.preparar(embedUrl)
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "overlay_wrapper",
                "origem" to ObaLog.host(wrapper),
            )
            wv.loadUrl(wrapper)
        }
    }

    private fun nomesCookiesDiagnostico(raw: String?): String {
        if (raw.isNullOrBlank()) return "nenhum"
        return raw.split(";")
            .mapNotNull {
                it.substringBefore("=").trim().takeIf(String::isNotEmpty)
            }
            .distinct()
            .joinToString(",")
            .take(200)
    }

    fun diagnosticarCookies(embedUrl: String) {
        val cookies = runCatching {
            CookieManager.getInstance().getCookie(embedUrl)
        }.getOrNull()

        ObaLog.evento(
            ObaLog.Fase.PROVEDOR,
            "overlay_cookie_jar",
            "host" to ObaLog.host(embedUrl),
            "nomes" to nomesCookiesDiagnostico(cookies),
        )
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
            // Invalida o endereco do wrapper: fora desta sessao ele nao existe.
            SuperflixWrapperHost.encerrar()
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
