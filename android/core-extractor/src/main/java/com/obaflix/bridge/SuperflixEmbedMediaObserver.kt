package com.obaflix.bridge

import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.obaflix.removerRequestedWithHeader
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.ByteArrayInputStream
import java.net.URL
import java.util.Collections
import java.util.concurrent.TimeUnit

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

/** Teto de leitura de um manifesto. Manifesto é texto curto; nada além disso. */
private const val EMBED_MANIFEST_MAX_BYTES = 512 * 1024

/** Quanto basta para reconhecer a assinatura de um contêiner MP4. */
private const val EMBED_SNIFF_BYTES = 64

/**
 * Roda o player externo entregue pelo Superflix numa WebView efêmera e observa
 * apenas a mídia que a própria página pede.
 *
 * Motivo de existir: esta variante do embed (o "Fire Player") nunca expôs o
 * POST legado `/player/index.php?do=getVideo` que `extractEmbedPlayer` usa. Ela
 * só entrega mídia pelo fluxo real da própria página. O Electron chegou ao
 * mesmo diagnóstico e resolveu do mesmo jeito — `runEmbedObservation` /
 * `observeEmbedMediaInBrowser` em `browser-extractor.js`: abre a página
 * legítima, observa o que ela pede e confirma o candidato lendo o começo do
 * corpo.
 *
 * **Independência deliberada da autorização.** Este observador não chama
 * `beginSuperflixObservation`, `finishSuperflixObservation`,
 * `observeSuperflixUrl` nem `observeSuperflixMedia`, e não toca no
 * `SuperflixChallengeOverlay`. Uma tentativa anterior compartilhou o token
 * global do `PlayerState`: ela roubou a observação do desafio, desligou a
 * autorização no meio e trouxe de volta a seleção manual. O Turnstile e este
 * observador não têm mais nada em comum além do provedor.
 *
 * Nada aqui resolve, fabrica ou decodifica proteção nenhuma: a página faz o que
 * faria sozinha, e nós só olhamos.
 */
object SuperflixEmbedMediaObserver {

    /** O que o começo do corpo diz que a URL é. */
    internal enum class Conteudo { HLS_MASTER, HLS_MEDIA, MP4 }

    internal data class Candidata(
        val url: String,
        val conteudo: Conteudo,
    ) {
        val tipo: String get() = if (conteudo == Conteudo.MP4) "mp4" else "hls"
        val ehMaster: Boolean get() = conteudo == Conteudo.HLS_MASTER
    }

    private val cliente: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .callTimeout(12, TimeUnit.SECONDS)
            .build()
    }

    // ── Classificação (pura, testável) ─────────────────────────────────────

    /**
     * Extensão explícita, quando existe.
     *
     * Só a extensão. Caminho opaco NÃO vira mídia por parecer aleatório — isso
     * é o que fazia qualquer requisição de telemetria virar candidata. Quem
     * decide sobre caminho opaco é o corpo, mais abaixo.
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
     * O que o começo do corpo é, segundo a mesma leitura que o Electron faz em
     * `sniffAndReadCandidate`: `#EXTM3U` abre manifesto HLS, `#EXT-X-STREAM-INF`
     * o distingue como master, `#EXTINF` como playlist de mídia; `ftyp`, `styp`
     * ou `moof` na primeira caixa abrem MP4.
     */
    internal fun classificar(bytes: ByteArray): Conteudo? {
        if (bytes.isEmpty()) return null

        val texto = String(
            bytes, 0, minOf(bytes.size, EMBED_MANIFEST_MAX_BYTES), Charsets.ISO_8859_1,
        )
        // A leitura é byte a byte (ISO-8859-1) de propósito: assinatura de MP4
        // não é texto. Então o BOM de UTF-8 chega como os três bytes crus, e é
        // assim que ele precisa ser removido.
        val semBom = texto.removePrefix("ï»¿").trimStart()
        if (semBom.startsWith("#EXTM3U")) {
            return if (semBom.contains("#EXT-X-STREAM-INF")) {
                Conteudo.HLS_MASTER
            } else {
                Conteudo.HLS_MEDIA
            }
        }

        // Caixa MP4: 4 bytes de tamanho e 4 de tipo. `ftyp` é o cabeçalho
        // normal, `styp`/`moof` aparecem em fragmentado.
        val prefixo = String(
            bytes, 0, minOf(bytes.size, EMBED_SNIFF_BYTES), Charsets.ISO_8859_1,
        )
        if (Regex("""(ftyp|styp|moof)""").containsMatchIn(prefixo.take(24))) {
            return Conteudo.MP4
        }
        return null
    }

    /** Ruído conhecido: nada disto é mídia, e sondar custa tempo e requisição. */
    internal fun ehRuido(rawUrl: String): Boolean {
        val url = runCatching { URL(rawUrl) }.getOrNull() ?: return true
        val host = url.host.lowercase()
        val caminho = url.path.lowercase()
        if (host.contains("doubleclick") || host.contains("googlesyndication") ||
            host.contains("google-analytics") || host.contains("googletagmanager") ||
            host.contains("facebook") || host.contains("adservice")
        ) return true
        if (caminho.contains("/ads/") || caminho.contains("/advert")) return true
        return Regex("""\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|json|html?)$""")
            .containsMatchIn(caminho)
    }

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

        val resolvida = CompletableDeferred<Candidata>()
        // Uma requisição por candidata, nunca duas: o link do player externo é
        // efêmero e já houve corrida em que a segunda chamada nascia noutra
        // sessão e derrubava a primeira.
        val jaSondadas = Collections.synchronizedSet(mutableSetOf<String>())
        // A melhor coisa vista até agora, para a playlist de mídia poder ceder
        // lugar a um master que chegue logo depois. Atômica porque quem escreve
        // é a thread da WebView e quem lê é a da extração.
        val melhor = java.util.concurrent.atomic.AtomicReference<Candidata?>(null)

        var observadora: WebView? = null
        var pai: ViewGroup? = null
        val inicio = android.os.SystemClock.elapsedRealtime()

        fun decorrido() = android.os.SystemClock.elapsedRealtime() - inicio

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
                        // A página só pede a mídia depois de o player começar,
                        // e aqui não há gesto de usuário nenhum para dar.
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

                        override fun shouldInterceptRequest(
                            view: WebView,
                            request: WebResourceRequest,
                        ): WebResourceResponse? =
                            avaliar(request, jaSondadas, ::decorrido) { candidata, corpo ->
                                registrar(candidata, resolvida) { melhor.set(it) }
                                corpo
                            }
                    }
                }

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
                "ms" to decorrido(),
            )

            return NativeExtractResult(
                stream = escolhida.url,
                referer = embedUrl,
                tipo = escolhida.tipo,
                isMaster = escolhida.ehMaster,
                userAgent = userAgent,
                // Já provada pela página real que a pediu: refazer a prova pela
                // rede nativa mediria outra coisa. Espelha o `verified` do
                // Electron e é o que `profileSource()` respeita.
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
            // Obrigatório em sucesso, erro, cancelamento e tempo esgotado: a
            // WebView não sobrevive à resolução em hipótese nenhuma.
            withContext(Dispatchers.Main.immediate) {
                observadora?.let { view ->
                    runCatching { view.stopLoading() }
                    runCatching { pai?.removeView(view) }
                    runCatching { view.destroy() }
                }
            }
        }
    }

    /** Guarda a candidata e acorda quem espera, uma vez só. */
    private fun registrar(
        candidata: Candidata,
        resolvida: CompletableDeferred<Candidata>,
        guardarMelhor: (Candidata) -> Unit,
    ) {
        if (candidata.ehMaster) guardarMelhor(candidata)
        resolvida.complete(candidata)
    }

    /**
     * Decide sobre uma requisição da página e, quando for o caso, faz a **única**
     * chamada de confirmação.
     *
     * A confirmação sai daqui, do momento e do contexto em que a própria página
     * pediu, com os cabeçalhos dela e o cookie do `CookieManager`. É este o
     * ponto que responde, com status, a pergunta que ficou aberta: se a mídia
     * do Fire Player só é aceita dentro da sessão do Chromium ou se qualquer
     * cliente com o mesmo contexto serve.
     *
     * Quando a resposta vem boa, o corpo volta para a WebView e a página segue
     * como se nada tivesse acontecido — o CDN continua vendo exatamente UMA
     * requisição para aquela URL, e não duas.
     */
    private inline fun avaliar(
        request: WebResourceRequest,
        jaSondadas: MutableSet<String>,
        decorrido: () -> Long,
        aoConfirmar: (Candidata, WebResourceResponse?) -> WebResourceResponse?,
    ): WebResourceResponse? {
        if (!request.method.equals("GET", ignoreCase = true)) return null
        val url = request.url.toString()
        if (!request.url.scheme.equals("https", ignoreCase = true)) return null
        if (ehRuido(url)) return null

        val porExtensao = tipoPorExtensao(url)
        val destino = request.requestHeaders.entries
            .firstOrNull { it.key.equals("Sec-Fetch-Dest", ignoreCase = true) }
            ?.value.orEmpty().lowercase()

        // MP4 explícito: aceito pela extensão e nunca sondado. Sondar seria
        // começar a baixar o filme.
        if (porExtensao == "mp4") {
            if (!jaSondadas.add(url)) return null
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "embed_first_media_seen",
                "host" to (request.url.host ?: "-"),
                "tipo" to "mp4",
                "origem" to "extensao",
                "ms" to decorrido(),
            )
            aoConfirmar(Candidata(url, Conteudo.MP4), null)
            return null
        }

        // HLS explícito, ou caminho opaco que a própria página está buscando
        // como dado/vídeo. Fora disso não se sonda nada.
        val vaiSondar = porExtensao == "hls" ||
            (porExtensao == null && (destino == "empty" || destino == "video"))
        if (!vaiSondar) return null
        if (!jaSondadas.add(url)) return null

        return confirmar(request, decorrido, aoConfirmar)
    }

    private inline fun confirmar(
        request: WebResourceRequest,
        decorrido: () -> Long,
        aoConfirmar: (Candidata, WebResourceResponse?) -> WebResourceResponse?,
    ): WebResourceResponse? {
        val url = request.url.toString()
        val construtor = Request.Builder().url(url).get()
        // Os cabeçalhos são os da própria página, não uma imitação nossa.
        request.requestHeaders.forEach { (nome, valor) ->
            if (!nome.equals("Accept-Encoding", ignoreCase = true) &&
                !nome.equals("Connection", ignoreCase = true) &&
                !nome.equals("Host", ignoreCase = true)
            ) {
                runCatching { construtor.header(nome, valor) }
            }
        }
        runCatching { CookieManager.getInstance().getCookie(url) }
            .getOrNull()
            ?.takeIf { it.isNotBlank() }
            ?.let { construtor.header("Cookie", it) }

        val resposta = runCatching { cliente.newCall(construtor.build()).execute() }
            .getOrElse { erro ->
                ObaLog.alerta(
                    ObaLog.Fase.PROVEDOR, "embed_sonda_falhou",
                    "host" to (request.url.host ?: "-"),
                    "erro" to erro.javaClass.simpleName,
                    "ms" to decorrido(),
                )
                return null
            }

        resposta.use { r ->
            // O status é a prova que faltava. Sem query, sem token, sem cookie:
            // host, classe de rota e código.
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "embed_sonda_status",
                "host" to (request.url.host ?: "-"),
                "status" to r.code,
                "ms" to decorrido(),
            )
            if (!r.isSuccessful) {
                // Nada foi consumido: 4xx/5xx não gastam o link. A página faz a
                // própria requisição e a observação continua valendo.
                return null
            }

            val corpo = r.body ?: return null
            val bytes = runCatching {
                corpo.byteStream().use { fluxo ->
                    val buffer = ByteArray(EMBED_MANIFEST_MAX_BYTES)
                    var lidos = 0
                    while (lidos < buffer.size) {
                        val n = fluxo.read(buffer, lidos, buffer.size - lidos)
                        if (n <= 0) break
                        lidos += n
                        // MP4 se revela na primeira caixa: para de ler antes de
                        // o filme começar a descer.
                        if (lidos >= EMBED_SNIFF_BYTES &&
                            classificar(buffer.copyOf(lidos)) == Conteudo.MP4
                        ) break
                    }
                    buffer.copyOf(lidos)
                }
            }.getOrNull() ?: return null

            val conteudo = classificar(bytes) ?: run {
                ObaLog.evento(
                    ObaLog.Fase.PROVEDOR, "embed_sonda_sem_midia",
                    "host" to (request.url.host ?: "-"),
                    "ms" to decorrido(),
                )
                return null
            }

            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "embed_first_media_seen",
                "host" to (request.url.host ?: "-"),
                "tipo" to if (conteudo == Conteudo.MP4) "mp4" else "hls",
                "master" to (conteudo == Conteudo.HLS_MASTER),
                "origem" to "corpo",
                "status" to r.code,
                "ms" to decorrido(),
            )

            val candidata = Candidata(url, conteudo)
            if (conteudo == Conteudo.MP4) {
                // Não devolve corpo: a leitura parou na primeira caixa e servir
                // um MP4 truncado quebraria a página. MP4 aceita Range e é
                // repedido sem prejuízo, como no Electron.
                aoConfirmar(candidata, null)
                return null
            }

            // Manifesto inteiro em mãos: devolve para a página, com os
            // cabeçalhos originais (CORS incluído). Assim o CDN viu uma
            // requisição só — a nossa — e a página segue funcionando.
            val cabecalhos = r.headers.names()
                .filterNot {
                    it.equals("Content-Encoding", ignoreCase = true) ||
                        it.equals("Content-Length", ignoreCase = true) ||
                        it.equals("Transfer-Encoding", ignoreCase = true) ||
                        it.equals("Connection", ignoreCase = true)
                }
                .associateWith { r.headers[it].orEmpty() }

            val servida = WebResourceResponse(
                r.header("Content-Type")?.substringBefore(';')?.trim()
                    ?.takeIf { it.isNotBlank() }
                    ?: "application/vnd.apple.mpegurl",
                "utf-8",
                r.code,
                r.message.takeIf { it.isNotBlank() } ?: "OK",
                cabecalhos,
                ByteArrayInputStream(bytes),
            )
            return aoConfirmar(candidata, servida)
        }
    }
}
