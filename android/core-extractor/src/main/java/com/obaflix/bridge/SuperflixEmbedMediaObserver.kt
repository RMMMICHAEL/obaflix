package com.obaflix.bridge

import android.annotation.SuppressLint
import android.net.Uri
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.obaflix.removerRequestedWithHeader
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.net.URL

/** Teto total da observação. Igual ao do Electron. */
private const val EMBED_TIMEOUT_MS = 20_000L

/**
 * Janela para uma playlist de mídia virar um master melhor.
 *
 * O player externo às vezes pede a variante antes do master. Master traz
 * qualidades e faixas; a playlist de mídia traz uma só. Vale esperar um
 * instante — e só um instante.
 */
private const val EMBED_MASTER_GRACE_MS = 1_500L

/** Teto do manifesto que atravessa a ponte. Manifesto é texto curto. */
private const val EMBED_MANIFEST_MAX_CHARS = 512 * 1024

/** Nome do canal de mensagens injetado no contexto da página do Fire Player. */
private const val EMBED_CANAL = "obaflixFireProbe"

/**
 * Roda o player externo entregue pelo Superflix numa WebView efêmera e observa
 * apenas a mídia que a própria página consegue consumir.
 *
 * ## Por que existe
 *
 * Esta variante do embed (o "Fire Player") nunca expôs o POST legado
 * `/player/index.php?do=getVideo` que `extractEmbedPlayer` usa: ela só entrega
 * mídia pelo fluxo real da própria página. O Electron chegou ao mesmo
 * diagnóstico e resolveu do mesmo jeito — `runEmbedObservation` /
 * `observeEmbedMediaInBrowser` em `browser-extractor.js`.
 *
 * ## O que o teste em aparelho provou
 *
 * Uma requisição HTTP nossa para a URL candidata responde **403 mesmo no
 * instante em que a página a pede**, com os cabeçalhos dela e o cookie do
 * `CookieManager` (`embed_sonda_status status=403`, repetido). A autorização
 * daquela mídia não é transportável por Cookie, UA, Referer, Origin ou
 * Sec-Fetch: ela pertence à sessão do Chromium. Então a requisição volta a ser
 * feita pelo **próprio Chromium**, e nada aqui a intercepta ou substitui.
 *
 * ## Como a prova positiva é obtida
 *
 * `shouldInterceptRequest` acontece **antes** da resposta: ele diz o que a
 * página vai pedir, nunca o que ela conseguiu. E o WebView do Android não tem
 * equivalente de `webRequest.onCompleted` com corpo para XHR/sub-recursos — é
 * a diferença de API que separa este arquivo do Electron.
 *
 * O que o Android oferece de suportado, e é o que se usa aqui:
 *
 *  - `addDocumentStartJavaScript` injeta um script **antes dos scripts da
 *    página**, restrito por origem;
 *  - `addWebMessageListener` cria um canal tipado de volta, também restrito por
 *    origem — o substituto moderno de `addJavascriptInterface`, sem expor
 *    método nativo nenhum a script de terceiro.
 *
 * O script embrulha `fetch` e `XMLHttpRequest` e relata **somente respostas
 * 2xx de HLS/MP4**: status, tipo, se é master, e o corpo apenas quando é
 * manifesto. Ele não lê, não guarda e não transporta token, cookie ou desafio;
 * não toca em resposta da Cloudflare; não tenta resolver Turnstile. Quando o
 * aparelho não suporta as duas APIs, o observador cai no comportamento
 * anterior — sem prova e sem manifesto — e diz isso no log.
 *
 * ## Independência da autorização
 *
 * Não chama `beginSuperflixObservation`, `finishSuperflixObservation`,
 * `observeSuperflixUrl` nem `observeSuperflixMedia`, e não toca no
 * `SuperflixChallengeOverlay`. Uma tentativa anterior compartilhou o token
 * global do `PlayerState`: roubou a observação do desafio, desligou a
 * autorização no meio e trouxe de volta a seleção manual.
 */
object SuperflixEmbedMediaObserver {

    /** O que a resposta que a página consumiu é. */
    internal enum class Conteudo { HLS_MASTER, HLS_MEDIA, MP4 }

    internal data class Candidata(
        val url: String,
        val conteudo: Conteudo,
        val status: Int,
        /** Corpo do manifesto, só para HLS e só quando o browser o consumiu. */
        val manifesto: String? = null,
    ) {
        val tipo: String get() = if (conteudo == Conteudo.MP4) "mp4" else "hls"
        val ehMaster: Boolean get() = conteudo == Conteudo.HLS_MASTER
    }

    // ── Classificação (pura, testável) ─────────────────────────────────────

    /**
     * O que o corpo é, segundo a mesma leitura que o Electron faz em
     * `sniffAndReadCandidate`: `#EXTM3U` abre manifesto HLS e
     * `#EXT-X-STREAM-INF` o distingue como master.
     */
    internal fun classificarManifesto(corpo: String?): Conteudo? {
        if (corpo.isNullOrEmpty()) return null
        val texto = corpo.removePrefix("﻿").trimStart()
        if (!texto.startsWith("#EXTM3U")) return null
        return if (texto.contains("#EXT-X-STREAM-INF")) {
            Conteudo.HLS_MASTER
        } else {
            Conteudo.HLS_MEDIA
        }
    }

    /**
     * Extensão explícita, quando existe.
     *
     * Caminho opaco NÃO vira mídia por parecer aleatório; para ele quem decide é
     * o corpo, acima.
     */
    internal fun tipoPorExtensao(rawUrl: String): String? {
        val caminho = runCatching { URL(rawUrl).path }.getOrNull()?.lowercase()
            ?: return null
        return when {
            caminho.endsWith(".m3u8") -> "hls"
            caminho.endsWith("/master.txt") -> "hls"
            caminho.endsWith(".mp4") -> "mp4"
            else -> null
        }
    }

    /**
     * Traduz uma mensagem do canal em candidata.
     *
     * Fica separada e sem Android por dentro justamente para ser testável: é
     * aqui que a prova entra no lado nativo, e uma mensagem malformada não pode
     * virar mídia.
     */
    internal fun candidataDaMensagem(bruta: String?): Candidata? {
        val json = runCatching { JSONObject(bruta ?: return null) }.getOrNull() ?: return null
        val url = json.optString("u").takeIf { it.isNotBlank() } ?: return null
        val status = json.optInt("s", 0)
        if (status !in 200..299) return null

        val corpo = json.optString("b").takeIf { it.isNotBlank() && it.length <= EMBED_MANIFEST_MAX_CHARS }
        val peloCorpo = classificarManifesto(corpo)
        if (peloCorpo != null) {
            return Candidata(url, peloCorpo, status, corpo)
        }
        // Sem corpo de manifesto, a extensão ainda vale — é o caso do MP4, que
        // nunca é lido inteiro para dentro da memória.
        return when (tipoPorExtensao(url)) {
            "mp4" -> Candidata(url, Conteudo.MP4, status)
            "hls" -> Candidata(url, Conteudo.HLS_MEDIA, status)
            else -> null
        }
    }

    /**
     * Script injetado antes dos scripts da página.
     *
     * Sem expressão regular e sem cifrão de propósito: o texto vive dentro de
     * uma string Kotlin, e um `$` solto viraria interpolação. Só embrulha
     * `fetch` e `XMLHttpRequest`, e só relata resposta 2xx que já seja mídia.
     */
    internal fun scriptDeInstrumentacao(): String = """
(function () {
  if (window.__obaFireProbe) { return; }
  window.__obaFireProbe = 1;
  var MAX = $EMBED_MANIFEST_MAX_CHARS;

  function canal() {
    try { return $EMBED_CANAL; } catch (e) { return null; }
  }
  function semQuery(u) {
    var s = String(u || "");
    var i = s.indexOf("?");
    if (i < 0) { i = s.indexOf("#"); }
    return (i < 0 ? s : s.slice(0, i)).toLowerCase();
  }
  function ehHls(u) {
    var p = semQuery(u);
    return p.slice(-5) === ".m3u8" || p.slice(-11) === "/master.txt";
  }
  function ehMp4(u) { return semQuery(u).slice(-4) === ".mp4"; }
  function ehManifesto(t) {
    if (typeof t !== "string") { return false; }
    var s = t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t;
    return s.replace(/^\s+/, "").indexOf("#EXTM3U") === 0;
  }
  function relatar(u, s, corpo) {
    var c = canal();
    if (!c) { return; }
    var pacote = { u: String(u || ""), s: s };
    if (ehManifesto(corpo) && corpo.length <= MAX) {
      pacote.b = corpo;
    } else if (!ehHls(u) && !ehMp4(u)) {
      return;
    }
    try { c.postMessage(JSON.stringify(pacote)); } catch (e) {}
  }

  var fetchOriginal = window.fetch;
  if (typeof fetchOriginal === "function") {
    window.fetch = function () {
      var pedido = arguments[0];
      var promessa = fetchOriginal.apply(this, arguments);
      try {
        return promessa.then(function (resposta) {
          try {
            var u = (resposta && resposta.url) ||
              (pedido && pedido.url) || String(pedido);
            if (resposta && resposta.ok) {
              if (ehHls(u)) {
                resposta.clone().text().then(function (t) {
                  relatar(u, resposta.status, t);
                }).catch(function () {
                  relatar(u, resposta.status, null);
                });
              } else if (ehMp4(u)) {
                relatar(u, resposta.status, null);
              }
            }
          } catch (e) {}
          return resposta;
        });
      } catch (e) { return promessa; }
    };
  }

  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var abrirOriginal = XHR.prototype.open;
    var enviarOriginal = XHR.prototype.send;
    XHR.prototype.open = function (metodo, url) {
      try { this.__obaUrl = url; } catch (e) {}
      return abrirOriginal.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      var self = this;
      try {
        self.addEventListener("load", function () {
          try {
            var u = self.responseURL || self.__obaUrl;
            if (self.status < 200 || self.status > 299) { return; }
            var corpo = null;
            if (ehHls(u)) {
              try { corpo = self.responseText; } catch (e) { corpo = null; }
            } else if (!ehMp4(u)) {
              return;
            }
            relatar(u, self.status, corpo);
          } catch (e) {}
        });
      } catch (e) {}
      return enviarOriginal.apply(this, arguments);
    };
  }
})();
"""

    // ── Observação ─────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    suspend fun observe(
        parentWebView: WebView,
        embedUrl: String,
        userAgent: String,
        referer: String,
    ): NativeExtractResult {
        val embed = runCatching { URL(embedUrl) }.getOrNull()
            ?: throw Exception("embed externo inválido")
        if (!embed.protocol.equals("https", ignoreCase = true)) {
            throw Exception("embed externo sem HTTPS")
        }
        // A instrumentação vive presa a esta origem e a mais nenhuma.
        val origem = "https://${embed.host}"

        val resolvida = CompletableDeferred<Candidata>()
        // Melhor coisa vista até agora: uma playlist de mídia cede lugar a um
        // master que chegue logo depois. Atômica porque quem escreve é a thread
        // da WebView e quem lê é a da extração.
        val melhor = java.util.concurrent.atomic.AtomicReference<Candidata?>(null)

        var observadora: WebView? = null
        var pai: ViewGroup? = null
        val inicio = android.os.SystemClock.elapsedRealtime()

        fun decorrido() = android.os.SystemClock.elapsedRealtime() - inicio

        fun registrar(candidata: Candidata) {
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "embed_browser_media_ok",
                "host" to ObaLog.host(candidata.url),
                "status" to candidata.status,
                "tipo" to candidata.tipo,
                "master" to candidata.ehMaster,
                "manifesto" to (candidata.manifesto != null),
                "ms" to decorrido(),
            )
            if (candidata.ehMaster) melhor.set(candidata)
            resolvida.complete(candidata)
        }

        try {
            withContext(Dispatchers.Main.immediate) {
                pai = parentWebView.parent as? ViewGroup
                    ?: throw Exception("container Android indisponível")

                observadora = WebView(parentWebView.context).apply configuracao@{
                    layoutParams = ViewGroup.LayoutParams(1, 1)
                    alpha = 0.01f
                    isClickable = false
                    isFocusable = false

                    settings.apply {
                        javaScriptEnabled = true
                        domStorageEnabled = true
                        // A página só pede a mídia depois de o player começar, e
                        // aqui não há gesto de usuário nenhum para dar.
                        mediaPlaybackRequiresUserGesture = false
                        userAgentString = userAgent
                        // Página de terceiro: nada de alcançar o disco.
                        allowFileAccess = false
                        allowContentAccess = false
                        setSupportMultipleWindows(false)
                        javaScriptCanOpenWindowsAutomatically = false
                    }

                    removerRequestedWithHeader(settings, "superflix_embed")

                    CookieManager.getInstance().apply {
                        setAcceptCookie(true)
                        setAcceptThirdPartyCookies(this@configuracao, true)
                    }

                    setDownloadListener { _, _, _, _, _ ->
                        ObaLog.alerta(ObaLog.Fase.PROVEDOR, "embed_download_bloqueado")
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
                        override fun onPageStarted(
                            view: WebView,
                            url: String,
                            favicon: android.graphics.Bitmap?,
                        ) {
                            super.onPageStarted(view, url, favicon)
                            ObaLog.evento(
                                ObaLog.Fase.PROVEDOR, "embed_page_started",
                                "host" to ObaLog.host(url),
                                "ms" to decorrido(),
                            )
                        }

                        override fun onPageFinished(view: WebView, url: String) {
                            super.onPageFinished(view, url)
                            ObaLog.evento(
                                ObaLog.Fase.PROVEDOR, "embed_page_finished",
                                "host" to ObaLog.host(url),
                                "ms" to decorrido(),
                            )
                        }

                        override fun shouldOverrideUrlLoading(
                            view: WebView,
                            request: WebResourceRequest,
                        ): Boolean {
                            // Sub-recursos seguem o fluxo normal da página; o
                            // frame principal só anda em HTTPS.
                            if (!request.isForMainFrame) return false
                            return !request.url.scheme.equals("https", ignoreCase = true)
                        }

                        // Nenhum shouldInterceptRequest: a requisição de mídia é
                        // do Chromium, e sequestrá-la foi exatamente o que o
                        // teste em aparelho reprovou.
                    }
                }

                instrumentar(observadora!!, origem, ::registrar, ::decorrido)

                pai!!.addView(observadora)

                ObaLog.evento(
                    ObaLog.Fase.PROVEDOR, "embed_navigation_start",
                    "host" to embed.host,
                )

                // O Referer legítimo é o que o resolvedor já tinha em mãos: sem
                // ele a página do Fire Player não chega a pedir mídia nenhuma.
                observadora!!.loadUrl(embedUrl, mapOf("Referer" to referer))
            }

            val candidata = withTimeout(EMBED_TIMEOUT_MS) { resolvida.await() }

            // MP4 e master terminam na hora; playlist de mídia ganha um instante
            // para um master aparecer. Mesma regra do Electron.
            val escolhida = if (candidata.conteudo == Conteudo.HLS_MEDIA) {
                delay(EMBED_MASTER_GRACE_MS)
                melhor.get()?.takeIf { it.ehMaster } ?: candidata
            } else {
                candidata
            }

            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "embed_resolve_done",
                "host" to ObaLog.host(escolhida.url),
                "tipo" to escolhida.tipo,
                "master" to escolhida.ehMaster,
                "manifesto" to (escolhida.manifesto != null),
                "ms" to decorrido(),
            )

            return NativeExtractResult(
                stream = escolhida.url,
                referer = embedUrl,
                tipo = escolhida.tipo,
                isMaster = escolhida.ehMaster,
                userAgent = userAgent,
                // Manifesto que o próprio contexto do browser consumiu, para o
                // pipeline nativo não precisar repetir a requisição protegida.
                // Efêmero: ninguém o guarda em disco nem o reaproveita depois.
                manifest = escolhida.manifesto,
                // Já provada pela página real que a consumiu. Espelha o
                // `verified` do Electron e é o que `profileSource()` respeita.
                verified = true,
            )
        } catch (_: TimeoutCancellationException) {
            ObaLog.alerta(
                ObaLog.Fase.PROVEDOR, "embed_observation_timeout",
                "host" to embed.host,
                "ms" to decorrido(),
            )
            throw Exception("player externo não entregou mídia em 20 segundos")
        } finally {
            // NonCancellable de propósito: troca de episódio cancela a corrotina,
            // e sem isto o `withContext` abaixo estouraria na hora e a WebView
            // ficaria pendurada no container para sempre. Destruir é obrigatório
            // em sucesso, erro, cancelamento e tempo esgotado.
            withContext(NonCancellable + Dispatchers.Main.immediate) {
                observadora?.let { view ->
                    runCatching { view.stopLoading() }
                    runCatching { view.loadUrl("about:blank") }
                    runCatching { pai?.removeView(view) }
                    runCatching { view.destroy() }
                }
                observadora = null
            }
        }
    }

    /**
     * Liga o canal de volta e injeta o script, os dois presos à origem do embed.
     *
     * Roda antes do `loadUrl` — é o que dá ao script a chance de embrulhar
     * `fetch`/`XHR` antes de o player da página existir.
     */
    private fun instrumentar(
        webView: WebView,
        origem: String,
        aoProvar: (Candidata) -> Unit,
        decorrido: () -> Long,
    ) {
        val temCanal = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        val temInjecao = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

        if (!temCanal || !temInjecao) {
            // Aparelho antigo: sem prova positiva e sem manifesto. A fonte
            // segue tentando, e o failover automático cobre a falha.
            ObaLog.alerta(
                ObaLog.Fase.PROVEDOR, "embed_prova_indisponivel",
                "canal" to temCanal,
                "injecao" to temInjecao,
            )
            return
        }

        val origens = setOf(origem)

        runCatching {
            WebViewCompat.addWebMessageListener(
                webView,
                EMBED_CANAL,
                origens,
                object : WebViewCompat.WebMessageListener {
                    override fun onPostMessage(
                        view: WebView,
                        message: WebMessageCompat,
                        sourceOrigin: Uri,
                        isMainFrame: Boolean,
                        replyProxy: JavaScriptReplyProxy,
                    ) {
                        // Mensagem vinda de página de terceiro é dado, nunca
                        // ordem: só vira candidata se passar pela tradução.
                        candidataDaMensagem(message.data)?.let(aoProvar)
                    }
                },
            )
            WebViewCompat.addDocumentStartJavaScript(
                webView,
                scriptDeInstrumentacao(),
                origens,
            )
        }.onFailure { erro ->
            ObaLog.alerta(
                ObaLog.Fase.PROVEDOR, "embed_instrumentacao_falhou",
                "erro" to erro.javaClass.simpleName,
                "ms" to decorrido(),
            )
        }
    }
}
