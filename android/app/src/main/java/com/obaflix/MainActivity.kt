package com.obaflix

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.obaflix.bridge.ObaLog
import com.obaflix.bridge.ObaflixBridge
import com.obaflix.bridge.SuperflixChallengeOverlay
import com.obaflix.player.PlayerWebViewClient
import com.obaflix.update.Atualizador
import com.obaflix.update.EstadoAtualizacao
import com.obaflix.update.Plataforma
import kotlinx.coroutines.launch
import java.util.UUID

private const val TAG = "Obaflix"

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var fullscreenView: View? = null
    private val bridgeCapability = UUID.randomUUID().toString()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Habilita inspeção via chrome://inspect/#devices (necessário para diagnosticar erros).
        // DIAG_LOGS permite o mesmo num APK de release, para investigar um bug que
        // só aparece no aparelho de alguém — ver -PdiagLogs em app/build.gradle.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG || BuildConfig.DIAG_LOGS)
        ObaLog.evento(
            ObaLog.Fase.SESSAO, "app_iniciado",
            "versao" to BuildConfig.VERSION_NAME,
            "diag" to BuildConfig.DIAG_LOGS,
        )
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        configureWebView()

        // O aplicativo sempre começa na experiência Android. Essa rota valida a
        // sessão no servidor e redireciona para /login antes de mostrar o catálogo.
        webView.loadUrl(BuildConfig.OBAFLIX_URL + "/android")

        iniciarChecagemDeAtualizacao()
    }

    /**
     * Checa, baixa e avisa o site quando a atualização está pronta.
     *
     * Mesmo mecanismo do Electron: `Atualizador` roda em segundo plano e só
     * publica [EstadoAtualizacao.Pronta] depois de a atualização estar
     * baixada e conferida. Daí em diante o fluxo é idêntico ao do Electron —
     * `window.__obaflixShowUpdate(versao)` aciona o MESMO banner web
     * (`DesktopUpdateBanner.tsx`), sem nenhuma mudança no site: ele já lê
     * `window.obaflixDesktop` sem saber (nem precisar saber) qual plataforma
     * o está implementando.
     */
    private fun iniciarChecagemDeAtualizacao() {
        Atualizador.iniciar(
            applicationContext,
            BuildConfig.UPDATE_MANIFEST_URL,
            Plataforma.ANDROID,
            BuildConfig.VERSION_CODE,
        )
        lifecycleScope.launch {
            Atualizador.estado.collect { estado ->
                if (estado is EstadoAtualizacao.Pronta) {
                    notificarAtualizacaoPronta(estado.info.versionName)
                }
            }
        }
    }

    private fun notificarAtualizacaoPronta(versao: String) {
        // Aspas simples escapadas: versionName vem do manifesto remoto, e
        // mesmo sendo um valor que o próprio backend publica, nada que chega
        // pela rede entra cru dentro de um literal JS.
        val seguro = versao.replace("\\", "\\\\").replace("'", "\\'")
        webView.post {
            webView.evaluateJavascript(
                "if (typeof window.__obaflixShowUpdate === 'function') " +
                    "window.__obaflixShowUpdate('$seguro');",
                null,
            )
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
            userAgentString = userAgentString.replace("wv", "") +
                " ObaflixApp/1.0"
            ObaflixApp.webViewUserAgent = userAgentString
        }

        removerRequestedWithHeader(webView.settings, "principal")

        // Reassinada tambem apos rebuildWebViewAposCrash, que chama este metodo.
        ObaflixApp.hostWebView = java.lang.ref.WeakReference(webView)

        // O Superflix roda em um iframe de outro domínio. A validação da
        // Cloudflare depende do cookie cf_clearance; sem cookies de terceiros o
        // desafio aparece, mas a sessão validada se perde na navegação seguinte.
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }

        // Bridge: expõe _obaflixBridge ao JS (shim cria window.obaflixDesktop)
        webView.addJavascriptInterface(
            ObaflixBridge(webView, lifecycleScope, bridgeCapability),
            "_obaflixBridge",
        )

        webView.webViewClient = PlayerWebViewClient(
            bridgeCapability = bridgeCapability,
            onPageReady = { view -> injectBridgeShim(view) },
            onRenderGone = { dead, crashed -> rebuildWebViewAposCrash(dead, crashed) },
        )

        registrarShimPrecoceDeAtualizacao()

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                val texto = msg.message()

                // As linhas "[diag/etapa]" vem de src/lib/playerDiag.ts e ja dizem
                // em qual estagio do funil HLS o player parou. Entram na trilha
                // como evento proprio, ao lado das fases nativas.
                if (texto.startsWith("[diag/etapa]")) {
                    val campos = texto.removePrefix("[diag/etapa]").trim().split(" ")
                        .mapNotNull { parte ->
                            val chave = parte.substringBefore('=', "")
                            if (chave.isEmpty()) null else chave to parte.substringAfter('=')
                        }
                    ObaLog.alerta(ObaLog.Fase.PLAYER, "diag_etapa", *campos.toTypedArray())
                    return false
                }

                // O console de uma pagina de terceiro imprime as URLs assinadas
                // do proprio provedor. Repassar cru colocava token e query no
                // logcat; ObaLog.texto mascara sem perder a mensagem.
                when (msg.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> ObaLog.alerta(
                        ObaLog.Fase.PLAYER, "console_erro",
                        "msg" to ObaLog.texto(texto).take(240),
                        "origem" to ObaLog.arquivo(msg.sourceId()),
                        "linha" to msg.lineNumber(),
                    )
                    // WARN e abaixo sao ruido em pagina de terceiro (o provedor
                    // enche o console). So saem com -PdiagLogs, e mascarados.
                    else -> if (BuildConfig.DIAG_LOGS) {
                        Log.d(TAG, "[JS] ${ObaLog.texto(texto).take(240)} — ${ObaLog.arquivo(msg.sourceId())}:${msg.lineNumber()}")
                    }
                }
                return false
            }

            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                ObaLog.evento(ObaLog.Fase.PLAYER, "tela_cheia", "ativo" to true)
                fullscreenView = view
                val container = findViewById<ViewGroup>(R.id.container)
                container.addView(view)
                webView.visibility = View.GONE
                hideSystemUi()
            }

            override fun onHideCustomView() {
                ObaLog.evento(ObaLog.Fase.PLAYER, "tela_cheia", "ativo" to false)
                fullscreenView?.let {
                    val container = findViewById<ViewGroup>(R.id.container)
                    container.removeView(it)
                }
                fullscreenView = null
                webView.visibility = View.VISIBLE
                showSystemUi()
            }
        }
    }

    /**
     * Recria a WebView depois que o processo de renderizacao morreu.
     *
     * A instancia morta nao volta a funcionar: qualquer chamada nela lanca. Por
     * isso ela sai da hierarquia e e destruida antes de uma nova entrar no mesmo
     * lugar do container. O usuario perde a posicao do video, mas o aplicativo
     * continua aberto — que era o comportamento quebrado que motivou isto.
     */
    @SuppressLint("SetJavaScriptEnabled")
    private fun rebuildWebViewAposCrash(dead: WebView, crashed: Boolean) {
        val container = findViewById<ViewGroup>(R.id.container)

        // Se o renderer morreu com o player em tela cheia, a view do fullscreen
        // fica orfa no container e cobriria a WebView nova.
        fullscreenView?.let { container.removeView(it) }
        fullscreenView = null
        showSystemUi()

        // A URL da instancia morta costuma continuar legivel; quando nao, volta
        // para a home do app em vez de abrir uma tela em branco.
        val destino = runCatching { dead.url }.getOrNull()
            ?.takeIf { it.startsWith("http", ignoreCase = true) }
            ?: (BuildConfig.OBAFLIX_URL + "/android")

        val posicao = container.indexOfChild(dead).takeIf { it >= 0 } ?: 0
        container.removeView(dead)
        runCatching { dead.destroy() }

        val nova = WebView(this)
        nova.id = R.id.webView
        nova.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        container.addView(nova, posicao)

        webView = nova
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        configureWebView()

        ObaLog.alerta(
            ObaLog.Fase.RENDER, "webview_recriada",
            "causa" to if (crashed) "crash" else "memoria",
            "destino" to ObaLog.url(destino),
        )
        Toast.makeText(
            this,
            "A reproducao falhou e o player foi reiniciado. Tente outro servidor.",
            Toast.LENGTH_LONG,
        ).show()

        webView.loadUrl(destino)
    }

    /**
     * Registra `onUpdateReady`/`installUpdate` ANTES de qualquer script da
     * própria página rodar — não só depois que ela termina de carregar.
     *
     * `injectBridgeShim` roda em `onPageFinished`, que dispara só depois do
     * evento `load` do documento — bem depois de o React já ter montado e
     * corrido os `useEffect` do primeiro render. `DesktopUpdateBanner.tsx`
     * registra o callback uma vez só, em `useEffect(() => {...}, [])`, sem
     * repetir: se `window.obaflixDesktop` ainda não existisse nesse instante,
     * o registro nunca aconteceria, e nenhum aviso chegaria nunca no Android
     * (o Electron não tem esse problema — o preload.js roda antes de
     * qualquer script da própria página, por construção).
     *
     * `addDocumentStartJavaScript` é o equivalente Android disso: corre no
     * início do parse do documento, antes do bundle do Next.js. Só faz o
     * mínimo — os dois métodos que o banner web já usa —, restrito à origem
     * do próprio site. `injectBridgeShim`, mais tarde, substitui este objeto
     * pela versão completa (extractStream, prepareSuperflix…); o sinalizador
     * `__obaflixEarly` é o que diferencia "só o esboço" de "já é o shim
     * inteiro" nesse meio-tempo.
     */
    private fun registrarShimPrecoceDeAtualizacao() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // WebView antiga (abaixo da 106): sem alternativa segura aqui.
            // injectBridgeShim ainda cobre tudo que não depende de estar
            // pronto antes do primeiro useEffect.
            ObaLog.alerta(ObaLog.Fase.ATUALIZACAO, "document_start_script_indisponivel")
            return
        }
        val script = """
            (function() {
                if (window.obaflixDesktop) return;
                window.obaflixDesktop = {
                    platform: 'android',
                    isAndroid: true,
                    __obaflixEarly: true,
                    onUpdateReady: function(cb) { window.__obaflixShowUpdate = cb; },
                    installUpdate: function() {
                        if (window._obaflixBridge) {
                            window._obaflixBridge.installUpdate('$bridgeCapability');
                        }
                    }
                };
            })();
        """.trimIndent()
        runCatching {
            WebViewCompat.addDocumentStartJavaScript(
                webView, script, setOf("${BuildConfig.OBAFLIX_URL}/*"),
            )
        }.onFailure { e ->
            ObaLog.alerta(ObaLog.Fase.ATUALIZACAO, "document_start_script_falhou", "excecao" to e.javaClass.simpleName)
        }
    }

    private fun injectBridgeShim(view: WebView) {
        val script = """
            (function() {
                document.documentElement.classList.add('obaflix-android-app');
                window.__OBAFLIX_ANDROID__ = true;
                // window.obaflixDesktop já pode existir aqui — vindo do shim
                // precoce (registrarShimPrecoceDeAtualizacao). __obaflixEarly
                // é só o esboço com onUpdateReady/installUpdate; substitui
                // por este objeto completo. Numa segunda chamada (raro: mais
                // de um onPageFinished para o mesmo documento) o objeto
                // completo já não tem essa marca, e aí sim só atualiza platform.
                if (window.obaflixDesktop && !window.obaflixDesktop.__obaflixEarly) {
                    window.obaflixDesktop.platform = 'android';
                    return;
                }
                window._obaflixCallbacks = {};
                var bridgeCapability = '$bridgeCapability';
                window.obaflixDesktop = {
                    platform: 'android',
                    isAndroid: true,
                    extractStream: function(embedUrl) {
                        return new Promise(function(resolve, reject) {
                            var id = Math.random().toString(36).slice(2) + Date.now();
                            window._obaflixCallbacks[id] = { resolve: resolve, reject: reject };
                            window._obaflixBridge.extractStream(bridgeCapability, id, embedUrl);
                        });
                    },
                    prepareSuperflix: function(embedUrl) {
                        return new Promise(function(resolve, reject) {
                            var id = Math.random().toString(36).slice(2) + Date.now();
                            window._obaflixCallbacks[id] = { resolve: resolve, reject: reject };
                            window._obaflixBridge.prepareSuperflix(bridgeCapability, id, embedUrl);
                        });
                    },
                    resolveSuperflix: function(sessionId, optionKey) {
                        return new Promise(function(resolve, reject) {
                            var id = Math.random().toString(36).slice(2) + Date.now();
                            window._obaflixCallbacks[id] = { resolve: resolve, reject: reject };
                            window._obaflixBridge.resolveSuperflix(
                                bridgeCapability, id, sessionId, optionKey
                            );
                        });
                    },
                    setKeepScreenOn: function(enabled) {
                        window._obaflixBridge.setKeepScreenOn(bridgeCapability, !!enabled);
                    },
                    // Igual ao preload.js do Electron: so registra o callback.
                    // Quem chama e o lado nativo (MainActivity.notificarAtualizacaoPronta),
                    // via window.__obaflixShowUpdate, quando a atualização já
                    // estiver baixada e conferida — nunca antes disso.
                    onUpdateReady: function(cb) { window.__obaflixShowUpdate = cb; },
                    installUpdate: function() {
                        window._obaflixBridge.installUpdate(bridgeCapability);
                    }
                };
                window.__OBAFLIX_DESKTOP__ = true;
            })();
        """.trimIndent()
        view.evaluateJavascript(script, null)
    }

    private fun hideSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )
    }

    private fun showSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
    }

    override fun onBackPressed() {
        // O overlay do desafio cobre a tela inteira; voltar precisa fecha-lo antes
        // de qualquer outra coisa, senao o usuario fica preso nele.
        if (SuperflixChallengeOverlay.estaAberto) {
            SuperflixChallengeOverlay.fechar()
            return
        }
        if (fullscreenView != null) {
            webView.webChromeClient?.onHideCustomView()
            return
        }
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onDestroy() {
        // destroy() com a WebView ainda anexada deixa o Chromium tentando desenhar
        // numa view ja destruida quando a Activity e recriada (rotacao, troca de
        // tema). Soltar antes e o que a documentacao pede.
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }
}
