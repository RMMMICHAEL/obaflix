package com.obaflix.bridge

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import com.obaflix.ObaflixApp
import com.obaflix.removerRequestedWithHeader
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.net.InetAddress
import java.net.URL

private const val REDECANAIS_HOST = "redecanais.capital"
private const val REDECANAIS_TIMEOUT_MS = 60_000L

/**
 * Executa o player original em um WebView efêmero e observa a URL de mídia que
 * o próprio navegador recebe. Não interpreta a VM/AES do provedor nem persiste
 * tokens: o WebView é destruído assim que a URL assinada é capturada.
 */
object RedeCanaisExtractor {

    fun isSupportedUrl(rawUrl: String): Boolean {
        val url = runCatching { URL(rawUrl) }.getOrNull() ?: return false
        if (url.protocol != "https") return false
        if (url.host != REDECANAIS_HOST && !url.host.endsWith(".$REDECANAIS_HOST")) return false
        val path = url.path.lowercase()
        return path.endsWith(".html") || path == "/watch.php" || path == "/player3/server.php"
    }

    private fun signedMediaUrl(rawUrl: String): String? {
        val uri = runCatching { Uri.parse(rawUrl) }.getOrNull() ?: return null
        val host = uri.host.orEmpty().lowercase()
        val path = uri.path.orEmpty()

        if (host == REDECANAIS_HOST && path == "/__RC__/proxy") {
            return uri.getQueryParameter("src")?.let(::validateSignedUrl)
        }

        return validateSignedUrl(rawUrl)
    }

    private fun validateSignedUrl(rawUrl: String): String? {
        val parsed = runCatching { URL(rawUrl) }.getOrNull() ?: return null
        val host = parsed.host.lowercase()
        if (parsed.protocol != "https") return null
        if (!host.endsWith(".pages.cloudflareusercontent.com")) return null
        if (!parsed.path.contains("/proxy")) return null
        return parsed.toString()
    }

    private suspend fun assertPublicDestination(stream: String) = withContext(Dispatchers.IO) {
        val host = URL(stream).host
        val addresses = InetAddress.getAllByName(host)
        if (addresses.isEmpty() || addresses.any {
                it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress ||
                    it.isSiteLocalAddress || it.isMulticastAddress
            }
        ) {
            throw Exception("destino de mídia bloqueado")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    suspend fun extract(parentWebView: WebView, embedUrl: String): ExtractResult {
        if (!isSupportedUrl(embedUrl)) throw Exception("URL RedeCanais inválida")

        val captured = CompletableDeferred<String>()
        var extractorView: WebView? = null
        var parent: ViewGroup? = null

        try {
            withContext(Dispatchers.Main.immediate) {
                parent = parentWebView.parent as? ViewGroup
                    ?: throw Exception("container Android indisponível")

                extractorView = WebView(parentWebView.context).apply webViewConfig@ {
                    layoutParams = ViewGroup.LayoutParams(1, 1)
                    alpha = 0.01f
                    isClickable = false
                    isFocusable = false

                    settings.apply {
                        javaScriptEnabled = true
                        domStorageEnabled = true
                        mediaPlaybackRequiresUserGesture = false
                        userAgentString = (
                            ObaflixApp.webViewUserAgent
                                ?: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 " +
                                    "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
                            ).replace(" ObaflixApp/1.0", "")
                    }

                    removerRequestedWithHeader(settings, "redecanais")

                    CookieManager.getInstance().apply {
                        setAcceptCookie(true)
                        setAcceptThirdPartyCookies(this@webViewConfig, true)
                    }

                    webChromeClient = object : WebChromeClient() {
                        override fun onCreateWindow(
                            view: WebView?,
                            isDialog: Boolean,
                            isUserGesture: Boolean,
                            resultMsg: android.os.Message?,
                        ): Boolean = false
                    }

                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(
                            view: WebView,
                            request: WebResourceRequest,
                        ): Boolean {
                            if (!request.isForMainFrame) return false
                            val targetHost = request.url.host.orEmpty().lowercase()
                            return targetHost != REDECANAIS_HOST &&
                                !targetHost.endsWith(".$REDECANAIS_HOST")
                        }

                        override fun shouldInterceptRequest(
                            view: WebView,
                            request: WebResourceRequest,
                        ): android.webkit.WebResourceResponse? {
                            if (request.method.equals("GET", ignoreCase = true)) {
                                signedMediaUrl(request.url.toString())?.let { stream ->
                                    if (captured.complete(stream)) {
                                        ObaLog.evento(ObaLog.Fase.PROVEDOR, "rc_mp4_assinado")
                                    }
                                }
                            }
                            return null
                        }

                        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                            super.onPageStarted(view, url, favicon)
                            ObaLog.evento(ObaLog.Fase.PROVEDOR, "rc_pagina", "caminho" to runCatching { URL(url).path }.getOrDefault("/"))
                        }

                        override fun onPageFinished(view: WebView, url: String) {
                            super.onPageFinished(view, url)
                            view.evaluateJavascript(
                                """
                                (function() {
                                  try {
                                    var video = document.querySelector('video');
                                    if (video) video.play().catch(function(){});
                                    var play = document.querySelector('.vjs-big-play-button');
                                    if (play) play.click();
                                  } catch (_) {}
                                })();
                                """.trimIndent(),
                                null,
                            )
                        }

                        override fun onReceivedError(
                            view: WebView,
                            request: WebResourceRequest,
                            error: WebResourceError,
                        ) {
                            if (request.isForMainFrame && !captured.isCompleted) {
                                captured.completeExceptionally(
                                    Exception("falha ao abrir o player RedeCanais (${error.errorCode})"),
                                )
                            }
                        }
                    }
                }

                parent!!.addView(extractorView)
                extractorView!!.loadUrl(
                    embedUrl,
                    mapOf("X-Requested-With" to "RC-Site-Requests"),
                )
            }

            val stream = withTimeout(REDECANAIS_TIMEOUT_MS) { captured.await() }
            assertPublicDestination(stream)

            val referer = "https://$REDECANAIS_HOST/"
            ObaflixApp.playerState.resetCdnHosts(URL(stream).host)
            ObaflixApp.playerState.embedReferer = referer
            return ExtractResult(stream = stream, referer = referer)
        } catch (error: kotlinx.coroutines.TimeoutCancellationException) {
            throw Exception("RedeCanais não entregou a mídia em 60 segundos")
        } finally {
            withContext(Dispatchers.Main.immediate) {
                extractorView?.let { view ->
                    runCatching { view.stopLoading() }
                    runCatching { parent?.removeView(view) }
                    runCatching { view.destroy() }
                }
            }
        }
    }
}
