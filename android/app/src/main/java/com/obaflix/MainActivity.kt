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
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.obaflix.bridge.ObaflixBridge
import com.obaflix.player.PlayerWebViewClient
import java.util.UUID

private const val TAG = "Obaflix"

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var fullscreenView: View? = null
    private val bridgeCapability = UUID.randomUUID().toString()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Habilita inspeção via chrome://inspect/#devices (necessário para diagnosticar erros)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        configureWebView()

        // O aplicativo sempre começa na experiência Android. Essa rota valida a
        // sessão no servidor e redireciona para /login antes de mostrar o catálogo.
        webView.loadUrl(BuildConfig.OBAFLIX_URL + "/android")
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

        webView.webViewClient = PlayerWebViewClient { view -> injectBridgeShim(view) }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                val level = when (msg.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> Log.ERROR
                    ConsoleMessage.MessageLevel.WARNING -> Log.WARN
                    else -> Log.DEBUG
                }
                Log.println(level, TAG, "[JS] ${msg.message()} — ${msg.sourceId()}:${msg.lineNumber()}")
                return false
            }

            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                fullscreenView = view
                val container = findViewById<ViewGroup>(R.id.container)
                container.addView(view)
                webView.visibility = View.GONE
                hideSystemUi()
            }

            override fun onHideCustomView() {
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

    private fun injectBridgeShim(view: WebView) {
        val script = """
            (function() {
                document.documentElement.classList.add('obaflix-android-app');
                window.__OBAFLIX_ANDROID__ = true;
                if (window.obaflixDesktop) {
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
                    setKeepScreenOn: function(enabled) {
                        window._obaflixBridge.setKeepScreenOn(bridgeCapability, !!enabled);
                    },
                    onUpdateReady: function(cb) { /* no-op: atualizações Android chegam via Play Store */ },
                    installUpdate: function() { /* no-op */ }
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
        webView.destroy()
        super.onDestroy()
    }
}
