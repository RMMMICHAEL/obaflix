package com.obaflix

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.obaflix.ads.AdGateBridge
import com.obaflix.ads.AdGateScript
import com.obaflix.ads.ObaflixAds
import com.obaflix.ads.PlaybackAdGate
import com.obaflix.bridge.ObaLog
import com.obaflix.bridge.ObaflixBridge
import com.obaflix.bridge.SuperflixChallengeOverlay
import com.obaflix.download.DownloadFolder
import com.obaflix.download.DownloadService
import com.obaflix.player.PlayerWebViewClient
import com.obaflix.update.Atualizador
import com.obaflix.update.EstadoAtualizacao
import com.obaflix.update.Plataforma
import kotlinx.coroutines.launch
import java.util.UUID

private const val TAG = "Obaflix"

/** Um gancho de excecao por processo, mesmo com a Activity recriada. */
private var diagnosticoDeCrashInstalado = false

/** Rastreamento do overlay do anuncio registrado uma vez por processo. */
private var lifecycleDoOverlayRegistrado = false

/**
 * Memo por processo de se `addDocumentStartJavaScript` e realmente usavel.
 *
 * Em API 28 a impl da AndroidX WebKit toca classes de API 29
 * (WebViewRenderProcessClient) e lanca NoClassDefFoundError, mesmo com
 * `WebViewFeature` reportando suporte — e o provider WebView ainda tropeca em
 * android.webkit.PacProcessor. Detectamos de forma barata (nivel de API) e
 * memorizamos, para nao repetir esse caminho caro a cada `configureWebView`
 * (que roda de novo apos um crash do renderer). `null` = ainda nao avaliado.
 */
private var documentStartUsavelCache: Boolean? = null

class MainActivity : AppCompatActivity(), AcoesDeMidiaHost {

    private lateinit var webView: WebView
    private var fullscreenView: View? = null
    private val bridgeCapability = UUID.randomUUID().toString()

    /** onResume ja passou desde o ultimo onPause (metade "foreground" da cond. B). */
    private var activityRetomada = false

    /**
     * Ponte de download e transmissao. Recriada junto com a WebView, porque
     * guarda a referencia dela para responder as Promises do JS.
     *
     * Independente do gate de anuncio: baixar e transmitir nao sao intencao de
     * reproducao e nunca passam por [PlaybackAdGate].
     */
    private var mediaBridge: MediaActionsBridge? = null

    /**
     * Seletor nativo de diretorio.
     *
     * `registerForActivityResult` tem de acontecer antes de a Activity ficar
     * STARTED — como inicializador de campo e o jeito recomendado, e o unico
     * que sobrevive a recriacao por rotacao sem lancar.
     */
    private val seletorDePasta =
        registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
            val ok = uri != null && DownloadFolder.guardar(this, uri)
            ObaLog.evento("download", "pasta_escolhida", "ok" to ok)
            // Continua o download que estava esperando a pasta — e o retorno
            // automatico ao app que o fluxo pede.
            mediaBridge?.pastaEscolhida(ok)
        }

    /**
     * POST_NOTIFICATIONS, so a partir do Android 13.
     *
     * Recusar nao impede o download: o servico em primeiro plano continua
     * rodando, so nao desenha a notificacao de progresso. Por isso o resultado
     * nao decide nada — e pedido, nao exigido.
     */
    private val permissaoDeNotificacao =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { concedida ->
            ObaLog.evento("download", "permissao_notificacao", "concedida" to concedida)
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val t0 = SystemClock.elapsedRealtime()
        instalarDiagnosticoDeCrash()
        rastrearOverlayDoAnuncio()
        ObaLog.evento(
            ObaLog.Fase.SESSAO, "app_iniciado",
            "versao" to BuildConfig.VERSION_NAME,
            "diag" to BuildConfig.DIAG_LOGS,
        )
        marcoStartup("startup_oncreate_start", t0)

        // Habilita inspeção via chrome://inspect/#devices (necessário para diagnosticar erros).
        // DIAG_LOGS permite o mesmo num APK de release, para investigar um bug que
        // só aparece no aparelho de alguém — ver -PdiagLogs em app/build.gradle.
        // So em debug/diag: em release comum esta chamada nem existe, entao a
        // inicializacao antecipada cara do provider WebView (com o tropeco em
        // PacProcessor na API 28) nao acontece no startup normal do usuario.
        marcoStartup("startup_webview_provider_start", t0)
        if (BuildConfig.DEBUG || BuildConfig.DIAG_LOGS) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        marcoStartup("startup_webview_provider_end", t0)

        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        marcoStartup("startup_configure_start", t0)
        configureWebView()
        marcoStartup("startup_configure_end", t0)

        // O aplicativo sempre começa na experiência Android. Essa rota valida a
        // sessão no servidor e redireciona para /login antes de mostrar o catálogo.
        marcoStartup("startup_load_url", t0)
        webView.loadUrl(BuildConfig.OBAFLIX_URL + "/android")

        // Aquecimento do Unity FORA do caminho critico: nada de esperar o SDK
        // antes da primeira renderizacao. Roda depois de a pagina ja ter sido
        // pedida. O anuncio precisa estar pronto so quando o usuario tocar em
        // ASSISTIR, muitos segundos depois de navegar o catalogo.
        webView.post {
            marcoStartup("startup_ads_start_async", t0)
            ObaflixAds.aquecer(applicationContext)
            marcoStartup("startup_ads_end", t0)
        }

        iniciarChecagemDeAtualizacao()
    }

    /** Marco de startup com duracao monotonica desde o inicio do onCreate. */
    private fun marcoStartup(evento: String, t0: Long) {
        ObaLog.evento(ObaLog.Fase.SESSAO, evento, "ms" to (SystemClock.elapsedRealtime() - t0))
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

    /**
     * Captura excecoes nao tratadas na trilha do [ObaLog] antes de o processo
     * cair, e entao delega ao handler padrao (que encerra normalmente).
     *
     * Motivo: investigar o "travou no primeiro contato" sem inventar causa. Os
     * logs do primeiro inicio mostravam HTTP 500 em /android e erro de Server
     * Components — pagina principal quebrada —, mas nada que comprove processo
     * encerrado por excecao/ANR. Este gancho registra `excecao_nao_tratada` com
     * o nome da excecao (sem dados sensiveis) para o proximo teste distinguir
     * crash real de pagina web quebrada. Instalado uma vez por processo.
     */
    private fun instalarDiagnosticoDeCrash() {
        if (diagnosticoDeCrashInstalado) return
        diagnosticoDeCrashInstalado = true
        val anterior = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, erro ->
            runCatching {
                ObaLog.falha(ObaLog.Fase.SESSAO, "excecao_nao_tratada", erro, "thread" to thread.name)
            }
            anterior?.uncaughtException(thread, erro)
        }
    }

    /**
     * Rastreia a Activity real do interstitial do Unity via
     * [Application.ActivityLifecycleCallbacks] — o unico sinal confiavel de que a
     * UI do anuncio ainda esta na frente. O SDK 4.18.x nao oferece callback de
     * "dismiss final" (so start/click/complete/failure), e `complete` chega com o
     * end-card ainda visivel; anuncios com varios end-cards/Xs so somem quando a
     * Activity do SDK e destruida. Enquanto ela existir, hold=true.
     *
     * Qualquer Activity que NAO seja a MainActivity, criada enquanto um anuncio
     * esta em andamento, e tratada como overlay do anuncio. Registramos o nome
     * simples da classe no log (sem dado sensivel) para PROVAR qual Activity o
     * SDK usa neste aparelho, sem depender de um nome presumido. Registrado uma
     * vez por processo.
     */
    private fun rastrearOverlayDoAnuncio() {
        if (lifecycleDoOverlayRegistrado) return
        lifecycleDoOverlayRegistrado = true
        application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            private fun overlay(activity: Activity) =
                activity !is MainActivity && ObaflixAds.anuncioEmExibicao

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
                if (overlay(activity)) ObaflixAds.aoOverlayCriado(activity.javaClass.simpleName)
            }
            override fun onActivityResumed(activity: Activity) {
                if (overlay(activity)) ObaflixAds.aoOverlayResumido(activity.javaClass.simpleName)
            }
            override fun onActivityPaused(activity: Activity) {
                if (overlay(activity)) ObaflixAds.aoOverlayPausado(activity.javaClass.simpleName)
            }
            override fun onActivityDestroyed(activity: Activity) {
                // Nao filtra por anuncioEmExibicao no destroy: a barreira precisa
                // contabilizar a saida mesmo se o estado ja estiver mudando.
                if (activity !is MainActivity) ObaflixAds.aoOverlayDestruido(activity.javaClass.simpleName)
            }
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
        })
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

        // Download/Cast vivem somente no app Android.
        // Nao passam pelo PlaybackAdGate.
        mediaBridge = MediaActionsBridge(
            activity = this,
            host = this,
            webView = webView,
            capability = bridgeCapability,
            escopo = lifecycleScope,
        )
        webView.addJavascriptInterface(
            mediaBridge!!,
            "_obaflixMedia",
        )

        webView.webViewClient = PlayerWebViewClient(
            bridgeCapability = bridgeCapability,
            onPageReady = { view ->
                injectBridgeShim(view)
                // Fallback do gate de anuncio: garante o interceptador de clique
                // mesmo quando addDocumentStartJavaScript falha (API 28/29).
                instalarAdGateNaPagina(view)
            },
            onRenderGone = { dead, crashed -> rebuildWebViewAposCrash(dead, crashed) },
        )

        registrarShimPrecoceDeAtualizacao()
        registrarAdGate()

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
    /**
     * `addDocumentStartJavaScript` e mesmo executavel neste aparelho?
     *
     * Deteccao barata e conservadora, memorizada por processo:
     *  - API < 29: a impl da AndroidX WebKit referencia
     *    `android.webkit.WebViewRenderProcessClient` (classe de API 29) e lanca
     *    NoClassDefFoundError no momento da chamada, mesmo com `WebViewFeature`
     *    dizendo "suportado". Nesses aparelhos nem tentamos — vamos direto ao
     *    fallback page_load, evitando o caminho caro a cada startup.
     *  - API >= 29: confia no `WebViewFeature`, mas dentro de runCatching (um
     *    LinkageError/NoClassDefFoundError raro tambem cai no fallback).
     *
     * Uma falha real na propria chamada tambem memoriza `false` (ver os dois
     * chamadores), para nao repetir a tentativa apos um rebuild da WebView.
     */
    private fun documentStartUsavel(): Boolean {
        documentStartUsavelCache?.let { return it }
        val ok = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            ObaLog.alerta(
                PlaybackAdGate.FASE, "ads_document_start_pulado",
                "motivo" to "api_${Build.VERSION.SDK_INT}",
            )
            false
        } else {
            runCatching {
                WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            }.getOrDefault(false)
        }
        documentStartUsavelCache = ok
        return ok
    }

    private fun registrarShimPrecoceDeAtualizacao() {
        if (!documentStartUsavel()) {
            // WebView antiga (abaixo da 106) ou API 28 incompativel: sem
            // alternativa segura aqui. injectBridgeShim ainda cobre tudo que
            // não depende de estar pronto antes do primeiro useEffect.
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
            // Regra de origem, nao padrao de URL: scheme://host, SEM caminho. Um
            // "/*" no fim tornava a regra invalida e addDocumentStartJavaScript
            // lancava IllegalArgumentException em todo aparelho — o document-start
            // do updater nunca instalava. Ver a mesma correcao em registrarAdGate.
            WebViewCompat.addDocumentStartJavaScript(
                webView, script, setOf(BuildConfig.OBAFLIX_URL),
            )
        }.onFailure { e ->
            // LinkageError/NoClassDefFoundError inesperado: memoriza para nao
            // repetir o caminho caro num proximo configureWebView.
            documentStartUsavelCache = false
            ObaLog.alerta(ObaLog.Fase.ATUALIZACAO, "document_start_script_falhou", "excecao" to e.javaClass.simpleName)
        }
    }

    /**
     * Liga o interceptador de intencao de reproducao a esta WebView.
     *
     * Duas metades: a ponte `_obaflixAds`, que so o modulo `:app` registra, e
     * o script de documento ([AdGateScript]), que observa cliques em ancoras
     * para `/assistir/...`. Restrito a origem do proprio site, como o shim de
     * atualizacao — nenhuma pagina de terceiro (o overlay do desafio, por
     * exemplo) recebe qualquer parte disto.
     *
     * Nada do pipeline de reproducao foi movido: o gate decide antes de a
     * navegacao acontecer, e portanto antes de qualquer resolucao de fonte.
     *
     * Chamado tambem por `rebuildWebViewAposCrash`, que refaz
     * `configureWebView` — a ponte nova aponta para a WebView nova. O
     * [PlaybackAdGate] continua sendo o mesmo (singleton em [ObaflixAds]),
     * entao o ciclo das series nao reinicia por causa de um crash do renderer.
     */
    private fun registrarAdGate() {
        ObaLog.evento(PlaybackAdGate.FASE, "ads_gate_register_start")
        val gate = ObaflixAds.gate(applicationContext)

        // A ponte precisa existir antes de a pagina carregar: e por ela que o
        // clique em ASSISTIR chega ao Kotlin. Exposta a todos os frames, como
        // _obaflixBridge, mas so age com o capability, que o AdGateScript injeta
        // apenas em documentos da origem oficial.
        webView.addJavascriptInterface(
            AdGateBridge(bridgeCapability, gate, this, webView),
            "_obaflixAds",
        )

        // Caminho preferido: document-start. Roda antes do bundle do Next e
        // cobre ate um clique muito cedo no primeiro documento. Em API < 29
        // documentStartUsavel() ja retorna false (evita o NoClassDefFoundError
        // de WebViewRenderProcessClient), e vamos direto ao fallback page_load.
        val suportado = documentStartUsavel()
        ObaLog.evento(PlaybackAdGate.FASE, "ads_gate_script_supported", "suportado" to suportado)

        if (suportado) {
            runCatching {
                // Regra de ORIGEM (scheme://host), nao padrao de URL: o "/*" que
                // havia aqui era invalido e fazia addDocumentStartJavaScript
                // lancar IllegalArgumentException. Sem o "/*", o document-start
                // funciona onde e suportado; o fallback continua de rede de
                // seguranca.
                WebViewCompat.addDocumentStartJavaScript(
                    webView,
                    AdGateScript.paraCapability(bridgeCapability),
                    setOf(BuildConfig.OBAFLIX_URL),
                )
            }.onSuccess {
                ObaLog.evento(PlaybackAdGate.FASE, "ads_gate_script_installed", "via" to "document_start")
            }.onFailure { e ->
                // LinkageError/NoClassDefFoundError inesperado (API >= 29): NAO
                // desabilita anuncio. Memoriza e deixa instalarAdGateNaPagina
                // assumir no onPageReady.
                documentStartUsavelCache = false
                ObaLog.alerta(
                    PlaybackAdGate.FASE, "gate_script_falhou",
                    "excecao" to e.javaClass.simpleName,
                )
            }
        } else {
            ObaLog.alerta(PlaybackAdGate.FASE, "gate_indisponivel")
        }
        // O fallback por pagina (instalarAdGateNaPagina) roda sempre no
        // onPageReady, independente do resultado acima. O AdGateScript e
        // idempotente (window.__obaflixAdGateInstalado), entao os dois caminhos
        // conviverem nunca instala dois listeners para o mesmo documento.
    }

    /**
     * Fallback do [AdGateScript] que nao depende de addDocumentStartJavaScript.
     *
     * Em API 28/29 o caminho de document-start da androidx.webkit pode lancar
     * NoClassDefFoundError, e sem alternativa o clique em ASSISTIR nunca era
     * interceptado — o gate nem chegava a decidir, e a reproducao comecava sem
     * anuncio. Aqui o mesmo script e injetado por `evaluateJavascript` quando a
     * pagina do proprio site termina de carregar, funcionando em qualquer nivel
     * de API.
     *
     * Restrito a origem oficial: so injeta quando a URL corrente e do Obaflix,
     * nunca em pagina de terceiro (overlay do desafio, iframe do provedor). Nao
     * cria nenhuma interface JS nova — reaproveita a ponte `_obaflixAds`, que ja
     * exige o capability.
     *
     * O listener do script e de captura no `document` e sobrevive as navegacoes
     * SPA (pushState) do Next, entao uma injecao por documento cobre a sessao
     * inteira; o guard do proprio script torna reinjecoes inofensivas.
     */
    private fun instalarAdGateNaPagina(view: WebView) {
        val url = runCatching { view.url }.getOrNull() ?: return
        if (!url.startsWith(BuildConfig.OBAFLIX_URL, ignoreCase = true)) return
        runCatching {
            view.evaluateJavascript(AdGateScript.paraCapability(bridgeCapability), null)
        }.onSuccess {
            ObaLog.evento(PlaybackAdGate.FASE, "ads_gate_script_installed", "via" to "page_load")
        }.onFailure { e ->
            ObaLog.alerta(
                PlaybackAdGate.FASE, "gate_script_falhou",
                "excecao" to e.javaClass.simpleName, "via" to "page_load",
            )
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
                // Envolve resolve/reject da ponte no gate de anuncio: com um
                // interstitial na tela, __obaflixAdGateDefer (definido pelo
                // AdGateScript) adia a resolucao ate o fechamento, para o player
                // so receber o stream — e so entao tocar — depois do anuncio. A
                // extracao em si (coroutine nativa) ja rodou em paralelo; aqui so
                // se segura a ENTREGA. Sem hold, passa direto.
                function obaAdGateCb(fn) {
                    return function(arg) {
                        try {
                            if (window.__obaflixAdGateDefer &&
                                window.__obaflixAdGateDefer(function() { fn(arg); })) {
                                return;
                            }
                        } catch (e) {}
                        fn(arg);
                    };
                }
                window.obaflixDesktop = {
                    platform: 'android',
                    isAndroid: true,
                    extractStream: function(embedUrl) {
                        return new Promise(function(resolve, reject) {
                            var id = Math.random().toString(36).slice(2) + Date.now();
                            window._obaflixCallbacks[id] = { resolve: obaAdGateCb(resolve), reject: obaAdGateCb(reject) };
                            window._obaflixBridge.extractStream(bridgeCapability, id, embedUrl);
                        });
                    },
                    prepareSuperflix: function(embedUrl) {
                        return new Promise(function(resolve, reject) {
                            var id = Math.random().toString(36).slice(2) + Date.now();
                            window._obaflixCallbacks[id] = { resolve: obaAdGateCb(resolve), reject: obaAdGateCb(reject) };
                            window._obaflixBridge.prepareSuperflix(bridgeCapability, id, embedUrl);
                        });
                    },
                    resolveSuperflix: function(sessionId, optionKey) {
                        return new Promise(function(resolve, reject) {
                            var id = Math.random().toString(36).slice(2) + Date.now();
                            window._obaflixCallbacks[id] = { resolve: obaAdGateCb(resolve), reject: obaAdGateCb(reject) };
                            window._obaflixBridge.resolveSuperflix(
                                bridgeCapability, id, sessionId, optionKey
                            );
                        });
                    },
                    setKeepScreenOn: function(enabled) {
                        window._obaflixBridge.setKeepScreenOn(bridgeCapability, !!enabled);
                    },

                    // Download/Cast sao exclusivos do APK Android.
                    // Nao usam obaAdGateCb e nao passam pelo PlaybackAdGate.
                    mediaActions: true,

                    inspectDownloadSource: function(payload) {
                        return new Promise(function(resolve, reject) {
                            var id = Math.random().toString(36).slice(2) + Date.now();
                            window._obaflixCallbacks[id] = { resolve: resolve, reject: reject };
                            try {
                                window._obaflixMedia.inspecionarFonte(
                                    bridgeCapability, id, JSON.stringify(payload || {})
                                );
                            } catch (e) {
                                delete window._obaflixCallbacks[id];
                                reject(e);
                            }
                        });
                    },

                    requestDownload: function(payload) {
                        return new Promise(function(resolve, reject) {
                            var id = Math.random().toString(36).slice(2) + Date.now();
                            window._obaflixCallbacks[id] = { resolve: resolve, reject: reject };
                            try {
                                window._obaflixMedia.solicitarDownload(
                                    bridgeCapability, id, JSON.stringify(payload || {})
                                );
                            } catch (e) {
                                delete window._obaflixCallbacks[id];
                                reject(e);
                            }
                        });
                    },

                    discardDownloadSource: function() {
                        window._obaflixMedia.descartarSondagem(bridgeCapability);
                    },

                    requestCast: function(payload) {
                        return new Promise(function(resolve, reject) {
                            var id = Math.random().toString(36).slice(2) + Date.now();
                            window._obaflixCallbacks[id] = { resolve: resolve, reject: reject };
                            try {
                                window._obaflixMedia.solicitarCast(
                                    bridgeCapability, id, JSON.stringify(payload || {})
                                );
                            } catch (e) {
                                delete window._obaflixCallbacks[id];
                                reject(e);
                            }
                        });
                    },

                    installCastApp: function() {
                        window._obaflixMedia.instalarAppDeCast(bridgeCapability);
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
        // Saiu do foreground (o anuncio subiu, ou o usuario trocou de app).
        activityRetomada = false
        ObaflixAds.aoMainFoco(false)
        // Durante um interstitial a Activity do anuncio traz o app para segundo
        // plano. Pausar a WebView aqui congelaria o JS e mataria a preparacao do
        // player que deve rodar por tras do anuncio. Mantemos a WebView viva
        // nesse caso — nenhum audio/video sai, porque o AdGateScript bloqueia a
        // reproducao e adia a entrega do stream ate o anuncio fechar. Fora do
        // anuncio, pausa normal.
        if (ObaflixAds.anuncioEmExibicao) {
            ObaLog.evento(PlaybackAdGate.FASE, "ads_webview_mantida_ativa")
            return
        }
        webView.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        activityRetomada = true
        sinalizarFocoDaMain()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        sinalizarFocoDaMain()
    }

    /**
     * Reporta ao gate o foco REAL da MainActivity (retomada + com foco de
     * janela). E a metade "MainActivity voltou" da confirmacao de fechamento; a
     * outra metade e o overlay do anuncio ter sumido (via ActivityLifecycle). O
     * gate ignora enquanto qualquer Activity do anuncio ainda existir, entao um
     * foco intermediario entre end-cards nao libera.
     */
    private fun sinalizarFocoDaMain() {
        val focado = activityRetomada && hasWindowFocus()
        if (ObaflixAds.anuncioEmExibicao) {
            ObaLog.evento(PlaybackAdGate.FASE, "ads_host_focus", "ativo" to focado)
        }
        ObaflixAds.aoMainFoco(focado)
    }


    override fun pedirPastaDeDownload() {
        seletorDePasta.launch(null)
    }

    override fun garantirPermissaoDeNotificacao() {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            permissaoDeNotificacao.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
    override fun onDestroy() {
        // Tela indo embora de verdade com um anuncio em andamento: cancela o hold
        // para nao deixar a barreira presa nem reproduzir numa superficie morta.
        // So no fechamento real (isFinishing); rotacao nao recria esta Activity
        // (configChanges no manifest).
        if (isFinishing) ObaflixAds.aoDestruirHost()
        // destroy() com a WebView ainda anexada deixa o Chromium tentando desenhar
        // numa view ja destruida quando a Activity e recriada (rotacao, troca de
        // tema). Soltar antes e o que a documentacao pede.
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }
}
