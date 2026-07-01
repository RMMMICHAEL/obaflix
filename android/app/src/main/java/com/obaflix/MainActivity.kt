package com.obaflix

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.obaflix.bridge.ObaflixBridge
import com.obaflix.player.PlayerWebViewClient

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var fullscreenView: View? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        configureWebView()

        webView.loadUrl(BuildConfig.OBAFLIX_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
            userAgentString = userAgentString.replace("wv", "") +
                " ObaflixApp/1.0"
        }

        // Bridge: expõe _obaflixBridge ao JS (shim cria window.obaflixDesktop)
        webView.addJavascriptInterface(
            ObaflixBridge(webView, lifecycleScope),
            "_obaflixBridge",
        )

        webView.webViewClient = PlayerWebViewClient()

        webView.webChromeClient = object : WebChromeClient() {
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

        // Injeta shim após cada página carregar para criar window.obaflixDesktop
        webView.webViewClient = object : PlayerWebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                injectBridgeShim(view)
            }
        }
    }

    private fun injectBridgeShim(view: WebView) {
        val script = """
            (function() {
                if (window.obaflixDesktop) return;
                window._obaflixCallbacks = {};
                window.obaflixDesktop = {
                    extractStream: function(embedUrl) {
                        return new Promise(function(resolve, reject) {
                            var id = Math.random().toString(36).slice(2) + Date.now();
                            window._obaflixCallbacks[id] = { resolve: resolve, reject: reject };
                            window._obaflixBridge.extractStream(id, embedUrl);
                        });
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
