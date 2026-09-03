package com.obaflix.player

import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.net.Uri
import androidx.annotation.RequiresApi
import com.obaflix.core.BuildConfig
import com.obaflix.ObaflixApp
import com.obaflix.bridge.ObaLog
import com.obaflix.bridge.PlayerExtractors
import com.obaflix.bridge.StreamExtractor
import com.obaflix.bridge.SuperflixChallengeOverlay
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.URL

/**
 * Substitui os handlers Electron em um único WebViewClient:
 *   - onBeforeRequest: intercept extract rola3/4 + CDN bypass (native=1)
 *   - onBeforeSendHeaders: injeção de Referer/UA nos requests CDN
 *   - onHeadersReceived: remoção do CSP (só no documento principal, preservando cookies)
 *
 * shouldInterceptRequest é chamado em background thread — operações bloqueantes são seguras.
 *
 * Divergência vs Electron (ver docs/android.md "Limitações de WebView"):
 * Electron usa `onBeforeRequest` com `redirectURL`, que é um redirect real de rede — o browser
 * refaz a requisição contra o novo host e a CSP não é reavaliada nesse caso específico, e
 * `onBeforeSendHeaders` (registrado para todas as URLs da sessão) injeta Referer/Origin em
 * QUALQUER request subsequente ao CDN (segmentos, sub-playlists, chaves), não só na primeira.
 * WebView não expõe um hook equivalente a `onBeforeSendHeaders` global; a única forma de
 * interceptar e modificar headers é via `shouldInterceptRequest`, que precisa então cobrir
 * explicitamente: (1) a requisição inicial ao manifest, (2) qualquer requisição direta ao
 * mesmo host do CDN (segmentos/sub-playlists com URL absoluta, que o hls.js busca fora do
 * path /api/player/proxy) e (3) a remoção de CSP do documento principal — sem essa remoção,
 * o connect-src do CSP bloqueia no próprio JS (antes mesmo de chegar aqui) qualquer fetch()
 * cross-origin que o hls.js faça direto ao CDN.
 */
class PlayerWebViewClient(
    /**
     * Token que a sonda de diagnostico usa para falar com a bridge. Vazio quando
     * este cliente serve uma pagina de terceiro (o overlay do desafio): la o
     * documento nunca e nosso, entao a sonda nao chega a ser injetada.
     */
    private val bridgeCapability: String = "",
    private val onPageReady: ((WebView) -> Unit)? = null,
    private val onRenderGone: ((WebView, Boolean) -> Unit)? = null,
    /**
     * Hosts que esta WebView pode navegar no frame principal, alem do nosso.
     *
     * Vazio por padrao: a WebView do aplicativo so navega para o proprio site, e
     * qualquer outro destino e recusado. O overlay do desafio precisa do
     * contrario — ele **e** a pagina do provedor, e bloquear a navegacao dela
     * deixava a tela branca, com o log dizendo "navegacao_externa_bloqueada"
     * para o proprio endereco que se pediu para abrir.
     *
     * Continua sendo lista fechada: so os hosts do provedor entram, e tudo o
     * mais segue recusado.
     */
    private val hostsNavegaveis: Set<String> = emptySet(),
    /**
     * Recursos servidos pelo proprio aplicativo, antes de qualquer rede.
     *
     * Hoje so o overlay do desafio usa: e por aqui que o documento que embute o
     * provedor sai de uma origem https local e estavel, em vez de um `data:`
     * disfarcado por `loadDataWithBaseURL`. Nulo em todo o resto do aplicativo,
     * entao o caminho normal fica exatamente como estava.
     */
    private val interceptadorLocal: ((Uri) -> WebResourceResponse?)? = null,
) : WebViewClient() {

    /** O host pertence a lista liberada para esta WebView? */
    private fun navegavel(host: String): Boolean =
        hostsNavegaveis.any { host == it || host.endsWith(".$it") }

    /**
     * Morte do processo de renderizacao da WebView.
     *
     * Sem este override o valor padrao e "false", e nesse caso o Android mata o
     * processo do aplicativo inteiro — o app "fecha sozinho" sem FATAL EXCEPTION
     * no logcat, porque nao houve excecao Java nenhuma: quem morreu foi o
     * renderer. Decodificar um MP4 invalido e uma das formas de chegar la.
     *
     * Retornar "true" avisa o sistema que o aplicativo assume o controle. A
     * WebView morta fica inutilizavel, entao quem trata precisa descarta-la e
     * criar outra; e o que rebuildWebViewAposCrash faz.
     */
    // A propria callback so existe da API 26 — abaixo disso o sistema mata o
    // processo sem avisar ninguem, e nao ha o que interceptar.
    @RequiresApi(android.os.Build.VERSION_CODES.O)
    override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
        val crashed = detail?.didCrash() ?: false
        val motivo = if (crashed) "crash do renderer" else "renderer encerrado pelo sistema (memoria)"
        ObaLog.falha(
            ObaLog.Fase.RENDER, "processo_morreu", null,
            "crash" to crashed,
            "motivo" to motivo,
            "prioridade" to (detail?.rendererPriorityAtExit() ?: -1),
        )
        if (view == null) return true
        onRenderGone?.invoke(view, crashed)
        return true
    }

    private val allowedAppHost = Uri.parse(BuildConfig.OBAFLIX_URL).host ?: ""

    private fun header(request: WebResourceRequest, name: String): String? =
        request.requestHeaders.entries
            .firstOrNull { it.key.equals(name, ignoreCase = true) }
            ?.value

    private fun superflixMediaKind(request: WebResourceRequest): String? {
        if (!ObaflixApp.playerState.superflixObservationActive) return null
        if (!request.method.equals("GET", ignoreCase = true)) return null

        val uri = request.url
        if (!uri.scheme.equals("https", ignoreCase = true)) return null
        val host = uri.host.orEmpty().lowercase()
        val path = uri.path.orEmpty().lowercase()
        if (host == allowedAppHost || host.contains("doubleclick") || host.contains("googlevideo") ||
            host.contains("googlesyndication") || path.contains("/ads/") || path.contains("/advert")
        ) return null

        val hls = path.endsWith(".m3u8") || path.endsWith("/master.txt") ||
            path.contains("/cdn/hls/") ||
            ((host.contains("embedplayer") || host.contains("hclod") || host.endsWith(".qzz.io")) &&
                Regex("^/m(?:3|d)/", RegexOption.IGNORE_CASE).containsMatchIn(path))
        if (hls) return "hls"

        val fileName = path.substringAfterLast('/')
        val isMediaElement = header(request, "Sec-Fetch-Dest")?.equals("video", ignoreCase = true) == true
        val hasRange = header(request, "Range") != null
        val mp4 = path.endsWith(".mp4") &&
            !fileName.startsWith("init") && !fileName.contains("segment") && !fileName.contains("chunk") &&
            (isMediaElement || hasRange)
        return if (mp4) "mp4" else null
    }

    /**
     * O player do provedor pede a legenda depois da mídia. Sem registrar esses
     * pedidos, a extração terminava antes deles e o episódio abria sem legenda.
     */
    private fun observeSuperflixSubtitle(request: WebResourceRequest) {
        if (!ObaflixApp.playerState.superflixObservationActive) return
        val uri = request.url
        if (!uri.scheme.equals("https", ignoreCase = true)) return
        val host = uri.host.orEmpty().lowercase()
        if (host == allowedAppHost) return
        val path = uri.path.orEmpty().lowercase()
        if (!Regex("""\.(?:vtt|srt)$""").containsMatchIn(path)) return
        ObaflixApp.playerState.observeSuperflixSubtitle(uri.toString(), header(request, "Referer"))
        ObaLog.evento(ObaLog.Fase.PROVEDOR, "legenda_observada", "url" to ObaLog.url(uri.toString()))
    }

    /**
     * Só os destinos de compartilhamento do provedor — o botão do Telegram e afins.
     *
     * A versão anterior também bloqueava navegações do SuperFlix para fora da tela
     * de servidores, para neutralizar a seta de voltar. Isso quebrou a extração: a
     * página do provedor usa iframe interno de mesma origem (visível no log como
     * "Blocked a frame with origin superflixapi.pro from accessing a frame with
     * origin superflixapi.pro"), e o shouldOverrideUrlLoading do WebView não informa
     * qual frame está navegando — então não há como distinguir o "voltar" do usuário
     * de um frame interno necessário, e o filtro derrubava os dois.
     *
     * No Electron a seta continua neutralizada, porque lá o webFrameMain permite
     * agir dentro do frame certo. No Android ela segue funcionando.
     */
    private fun isProviderEscapeNavigation(uri: Uri): Boolean {
        val host = uri.host.orEmpty().lowercase()
        return Regex("""(^|\.)(t\.me|telegram\.me|telegram\.org|wa\.me|whatsapp\.com|facebook\.com|twitter\.com|x\.com)$""")
            .containsMatchIn(host)
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        val providerHost = uri.host.orEmpty().lowercase()
        if ((providerHost.contains("superflixapi.") || providerHost.contains("vizer") ||
                providerHost.contains("warezcdn")) && !uri.path.orEmpty().startsWith("/cdn-cgi/")
        ) {
            // Sem query para não registrar tokens; host+path identifica a rota que
            // terminou em 404 caso o provedor mude novamente.
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "navegacao",
                "principal" to request.isForMainFrame,
                "url" to ObaLog.url(uri.toString()),
            )
        }
        if (!request.isForMainFrame) {
            if (isProviderEscapeNavigation(uri)) {
                ObaLog.evento(ObaLog.Fase.PROVEDOR, "navegacao_bloqueada", "host" to providerHost)
                return true
            }
            return false
        }
        if (uri.scheme == "https" && uri.host == allowedAppHost) return false
        // Pagina do provedor no overlay do desafio: e ela que tem de carregar.
        if (uri.scheme == "https" && navegavel(providerHost)) return false
        if (uri.scheme == "http" || uri.scheme == "https") {
            ObaLog.alerta(
                ObaLog.Fase.PROVEDOR, "navegacao_externa_bloqueada",
                "host" to uri.host,
            )
        }
        return true
    }

    override fun onPageFinished(view: WebView, url: String) {
        super.onPageFinished(view, url)
        onPageReady?.invoke(view)
    }

    /**
     * Falha de rede num recurso da pagina — hoje invisivel.
     *
     * O widget do desafio vive num iframe de terceiro: quando ele nao carrega, o
     * sintoma que chega ate nos e "o desafio nunca conclui", sem nenhuma pista
     * de que a causa foi um recurso recusado. Registra host e codigo; a URL sai
     * por ObaLog.host, entao nenhum caminho, query ou token e gravado.
     */
    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: android.webkit.WebResourceError,
    ) {
        super.onReceivedError(view, request, error)
        ObaLog.alerta(
            ObaLog.Fase.PROVEDOR, "recurso_falhou",
            "host" to ObaLog.host(request.url.toString()),
            "principal" to request.isForMainFrame,
            "codigo" to error.errorCode,
        )
    }

    override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: android.webkit.WebResourceResponse,
    ) {
        super.onReceivedHttpError(view, request, errorResponse)
        ObaLog.alerta(
            ObaLog.Fase.PROVEDOR, "recurso_http_erro",
            "host" to ObaLog.host(request.url.toString()),
            "principal" to request.isForMainFrame,
            "status" to errorResponse.statusCode,
        )
    }

    private val UA =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/122.0.0.0 Mobile Safari/537.36 ObaflixApp/1.0"

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? {
        val path = request.url.path ?: ""
        val host = request.url.host ?: ""

        // Antes de tudo: o recurso pode ser nosso, servido de dentro do
        // aplicativo. Nao ha host de provedor nem de CDN envolvido, entao
        // nenhuma das etapas abaixo teria o que fazer com ele.
        interceptadorLocal?.invoke(request.url)?.let { return it }

        marcarSelecaoSuperflix(host, path)

        superflixMediaKind(request)?.let { kind ->
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "midia_observada",
                "tipo" to kind,
                "url" to ObaLog.url(request.url.toString()),
            )
            // Assumir a requisicao e o unico jeito de saber com que status o CDN
            // respondeu — ver passarMidiaSuperflix. Quando nao da, registra sem
            // status e a sonda do extrator decide, como antes.
            passarMidiaSuperflix(request, kind)?.let { return it }
            ObaflixApp.playerState.observeSuperflixMedia(
                request.url.toString(), header(request, "Referer"), kind, 0,
            )
        }
        observeSuperflixSubtitle(request)

        val isSuperflixSignedRoute = host.contains("superflixapi.") &&
            (request.url.getQueryParameter("cfv") != null || path.startsWith("/player/redirect"))
        if (isSuperflixSignedRoute || host.contains("vizer") || host.contains("warezcdn")) {
            ObaflixApp.playerState.observeSuperflixUrl(request.url.toString())
            ObaLog.evento(ObaLog.Fase.PROVEDOR, "rota_observada", "url" to ObaLog.url(request.url.toString()))
        }

        // 1. Extração nativa (rola3/rola4/hide/lulu/rola2/wish/bolt/big) → StreamExtractor
        //    (usa OkHttp com IP do usuário) — ver PlayerExtractors.detectProvider().
        if (path == "/api/player/extract") {
            val embedUrl = request.url.getQueryParameter("url") ?: return null
            if (PlayerExtractors.detectProvider(embedUrl) != null) {
                ObaLog.evento(
                    ObaLog.Fase.EXTRACAO, "intercept_nativo",
                    "provedor" to PlayerExtractors.detectProvider(embedUrl),
                )
                val comecoExtracao = System.currentTimeMillis()
                return try {
                    val result = runBlocking { StreamExtractor.extract(embedUrl) }
                    val tipo = if (result.stream.contains(".mp4")) "mp4" else "hls"
                    ObaLog.evento(
                        ObaLog.Fase.EXTRACAO, "intercept_ok",
                        "tipo" to tipo,
                        "ms" to (System.currentTimeMillis() - comecoExtracao),
                        "stream" to ObaLog.url(result.stream),
                    )
                    val json = JSONObject().apply {
                        put("stream", result.stream)
                        put("tipo", tipo)
                        if (result.referer != null) {
                            put("referer", result.referer)
                        } else {
                            put("referer", JSONObject.NULL)
                        }
                    }.toString()
                    WebResourceResponse(
                        "application/json", "UTF-8",
                        ByteArrayInputStream(json.toByteArray()),
                    )
                } catch (e: Exception) {
                    ObaLog.falha(
                        ObaLog.Fase.EXTRACAO, "intercept_falhou", e,
                        "ms" to (System.currentTimeMillis() - comecoExtracao),
                    )
                    val json = JSONObject().put("error", e.message ?: "Erro").toString()
                    WebResourceResponse(
                        "application/json", "UTF-8", 422, "Unprocessable Entity",
                        mapOf("Access-Control-Allow-Origin" to "*"),
                        ByteArrayInputStream(json.toByteArray()),
                    )
                }
            }
        }

        // 2. Proxy CDN bypass: /api/player/proxy?url=<cdn>&native=1 (sem sig=)
        //    Cobre apenas a PRIMEIRA requisição (o manifest), montada por buildElectronProxyUrl.
        if (path == "/api/player/proxy") {
            val cdnUrl = request.url.getQueryParameter("url") ?: return null
            val hasSig = request.url.getQueryParameter("sig") != null
            val isNative = request.url.getQueryParameter("native") == "1"
            if (!hasSig && isNative) {
                ObaLog.evento(
                    ObaLog.Fase.CDN, "proxy_desviado",
                    "url" to ObaLog.url(cdnUrl),
                )
                return fetchCdnDirect(cdnUrl, request)
            }
            // sig= ou sem native=1: deixa seguir para o proxy Vercel normal (não é rola3/4 nativo)
            return null
        }

        // 3. Requisições diretas aos hosts descobertos na cadeia HLS. O Player 1 começa em
        //    embedplayer2.xyz, mas suas sub-playlists apontam os fragmentos para hcloud.qzz.io.
        //    Todos os hosts só são liberados depois de aparecerem num manifesto já autorizado.
        //    Sem este branch, essas requisições saem sem Referer/Origin/CORS → 403 do CDN.
        //    Equivale ao branch "isCdnReq" do onBeforeSendHeaders (main.js), que é universal
        //    porque Electron registra o listener para "*://*/*".
        if (request.method.equals("GET", ignoreCase = true) &&
            ObaflixApp.playerState.isAllowedCdnHost(host)
        ) {
            ObaLog.evento(
                ObaLog.Fase.CDN, "pedido",
                "arquivo" to ObaLog.arquivo(request.url.toString()),
                "host" to host,
                "range" to (header(request, "Range") != null),
            )
            return fetchCdnDirect(request.url.toString(), request)
        }

        // 4. Documento principal (navegação de topo) do site — remove CSP preservando cookies.
        //    Sem isso, o connect-src do CSP bloqueia no próprio JS qualquer fetch() cross-origin
        //    que o hls.js faça direto ao CDN (branch 3 acima nunca seria alcançado: CSP bloqueia
        //    antes da requisição chegar à camada de rede/shouldInterceptRequest).
        //    Escopo restrito a isForMainFrame: cobre apenas o carregamento inicial da página
        //    (o CSP vale para toda a vida do documento; navegação client-side do Next.js não
        //    refaz a requisição de documento, então não precisa reinterceptar).
        // "GET" only: fetchDocumentWithoutCsp refaz via Request.Builder sem repassar o corpo
        // original. Uma navegação POST (ex.: submit de formulário sem JS) viraria GET — por
        // segurança, deixa esses casos raros seguirem o fluxo nativo normal da WebView (com CSP).
        if (request.isForMainFrame && request.method.equals("GET", ignoreCase = true) &&
            host == allowedAppHost
        ) {
            ObaLog.evento(ObaLog.Fase.DOCUMENTO, "csp_removido", "caminho" to path)
            return fetchDocumentWithoutCsp(request)
        }

        return null
    }

    /**
     * Marcos da escolha de servidor, na mesma leitura que o Electron faz.
     *
     * `/player/source` e o POST que a pagina so dispara quando um servidor e
     * escolhido: e ele que devolve o `video_url`. `/player/redirect` e o salto
     * seguinte, ja a caminho do CDN. O Electron os enxerga pelo `webRequest`
     * da sessao; aqui eles passam por `shouldInterceptRequest` como qualquer
     * outra requisicao da pagina.
     */
    private fun marcarSelecaoSuperflix(host: String, path: String) {
        if (!ObaflixApp.playerState.superflixObservationActive) return
        if (!host.contains("superflixapi.")) return
        val rota = path.lowercase()
        if (rota.startsWith("/player/source")) {
            ObaflixApp.playerState.confirmarSelecaoSuperflix("player/source")
        } else if (rota.startsWith("/player/redirect")) {
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "navegacao_pos_selecao",
                "rota" to "player/redirect",
                "posSelecao" to ObaflixApp.playerState.superflixSelecionado,
            )
        }
    }

    /** Cabecalhos que sao da conexao, nao do pedido: repassa-los corrompe a nova. */
    private fun ehCabecalhoDeConexao(nome: String): Boolean =
        nome.equals("Host", ignoreCase = true) ||
            nome.equals("Connection", ignoreCase = true) ||
            nome.equals("Cookie", ignoreCase = true) ||
            // OkHttp negocia gzip sozinho e ja entrega o corpo decodificado;
            // repassar o pedido original faria o corpo chegar comprimido sem
            // que o Content-Encoding sobrevivesse.
            nome.equals("Accept-Encoding", ignoreCase = true)

    /**
     * Faz a requisicao de midia do provedor por nos — e devolve a resposta a
     * pagina, que segue funcionando.
     *
     * Este e o equivalente Android do `webRequest.onCompleted` do Electron. La
     * o `statusCode` chega de graca e o `capture()` recusa tudo fora de
     * 2xx/3xx; foi assim que o Electron nunca guardou a midia do player que a
     * pagina arranca sozinha. A WebView nao expoe status nenhum em
     * `shouldInterceptRequest`: so ha o pedido. Refazer a requisicao por fora,
     * como a versao anterior fazia, mede **outra** requisicao — e em URL
     * assinada de uso unico as duas nem sao a mesma coisa.
     *
     * Assumindo o pedido, o status medido e o da propria requisicao da pagina,
     * e o corpo volta para ela. Escopo estreito de proposito: so candidata a
     * midia, so enquanto a observacao esta aberta. Qualquer falha devolve null
     * e a WebView busca sozinha, exatamente como antes.
     */
    private fun passarMidiaSuperflix(
        request: WebResourceRequest,
        kind: String,
    ): WebResourceResponse? = try {
        val urlPedida = request.url.toString()
        val construtor = Request.Builder().url(urlPedida).get()
        var temUa = false
        request.requestHeaders.forEach { (nome, valor) ->
            if (ehCabecalhoDeConexao(nome)) return@forEach
            if (nome.equals("User-Agent", ignoreCase = true)) temUa = true
            construtor.header(nome, valor)
        }
        // A WebView nem sempre entrega o User-Agent no mapa, e este link nasceu
        // dentro do overlay: quem o pediu tem de ser o mesmo UA.
        if (!temUa) {
            construtor.header(
                "User-Agent",
                SuperflixChallengeOverlay.uaEmUso ?: ObaflixApp.webViewUserAgent ?: UA,
            )
        }
        CookieManager.getInstance().getCookie(urlPedida)
            ?.takeIf { it.isNotBlank() }
            ?.let { construtor.header("Cookie", it) }

        val resposta = ObaflixApp.mediaClient.newCall(construtor.build()).execute()
        val urlFinal = resposta.request.url.toString()
        if (urlFinal != urlPedida) {
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "navegacao_pos_selecao",
                "rota" to "redirect_midia",
                "de" to ObaLog.url(urlPedida),
                "para" to ObaLog.url(urlFinal),
            )
        }
        ObaflixApp.playerState.observeSuperflixMedia(
            urlFinal, header(request, "Referer"), kind, resposta.code,
        )

        val tipoUpstream = resposta.header("Content-Type")?.substringBefore(';')?.trim()
        val tipo = if (tipoUpstream.isNullOrEmpty()) {
            if (kind == "hls") "application/vnd.apple.mpegurl" else "video/mp4"
        } else {
            tipoUpstream
        }
        val cabecalhos = mutableMapOf("Access-Control-Allow-Origin" to "*")
        resposta.header("Content-Range")?.let { cabecalhos["Content-Range"] = it }
        resposta.header("Content-Length")?.let { cabecalhos["Content-Length"] = it }
        WebResourceResponse(
            tipo,
            if (kind == "hls") "utf-8" else null,
            resposta.code,
            // HTTP/2 nao tem reason phrase, e WebResourceResponse recusa vazio.
            resposta.message.ifEmpty { "OK" },
            cabecalhos,
            resposta.body?.byteStream() ?: ByteArrayInputStream(ByteArray(0)),
        )
    } catch (e: Exception) {
        ObaLog.alerta(
            ObaLog.Fase.PROVEDOR, "midia_intercepcao_falhou",
            "tipo" to kind,
            "causa" to ObaLog.texto(e.message ?: e.javaClass.simpleName),
        )
        null
    }

    private fun fetchCdnDirect(cdnUrl: String, original: WebResourceRequest): WebResourceResponse? {
        return try {
            val state = ObaflixApp.playerState
            val cdnHost = try { URL(cdnUrl).host } catch (_: Exception) { "" }
            val reqBuilder = Request.Builder().url(cdnUrl).get()
                .addHeader(
                    "User-Agent",
                    state.mediaUserAgent ?: ObaflixApp.webViewUserAgent ?: UA,
                )
                // Headers necessários para CDNs com bot-detection — sem eles, alguns CDNs
                // retornam 403 porque a request não parece vir de um browser real.
                .addHeader("Accept", "*/*")
                .addHeader("Accept-Language", "pt-BR,pt;q=0.5,en-US;q=0.3,en;q=0.2")
                .addHeader("Sec-Fetch-Dest", "empty")
                .addHeader("Sec-Fetch-Mode", "cors")
                .addHeader("Sec-Fetch-Site", "cross-site")

            CookieManager.getInstance().getCookie(cdnUrl)
                ?.takeIf { it.isNotBlank() }
                ?.let { reqBuilder.addHeader("Cookie", it) }

            val isCdnHost = state.isAllowedCdnHost(cdnHost)
            if (isCdnHost && state.embedReferer != null) {
                reqBuilder.addHeader("Referer", state.embedReferer!!)
                try {
                    val embedOrigin = URL(state.embedReferer!!).let { "${it.protocol}://${it.host}" }
                    reqBuilder.addHeader("Origin", embedOrigin)
                } catch (_: Exception) { }
            } else {
                ObaLog.alerta(
                    ObaLog.Fase.CDN, "sem_referer",
                    "host" to cdnHost,
                    "hostLiberado" to isCdnHost,
                    "temReferer" to (state.embedReferer != null),
                )
            }

            // header() e case-insensitive de proposito: a WebView normaliza os nomes
            // por versao, e a leitura direta do mapa ("Range") ja perdeu o header em
            // aparelhos que entregam "range". Sem Range repassado, o CDN devolve o
            // arquivo inteiro a partir do byte zero e a busca na barra de progresso
            // volta para o comeco do episodio.
            header(original, "Range")?.let { reqBuilder.addHeader("Range", it) }

            val comeco = System.currentTimeMillis()
            // mediaClient (sem read timeout): o WebView consome este corpo devagar,
            // no ritmo do buffer do player. Ver ObaflixApp.mediaClient.
            val response = ObaflixApp.mediaClient.newCall(reqBuilder.build()).execute()

            if (!response.isSuccessful) {
                ObaLog.alerta(
                    ObaLog.Fase.CDN, "status_nao_2xx",
                    "status" to response.code,
                    "arquivo" to ObaLog.arquivo(cdnUrl),
                    "host" to cdnHost,
                    "ms" to (System.currentTimeMillis() - comeco),
                )
            }

            val upstreamContentType = response.header("Content-Type", "application/octet-stream")!!
            val mediaPath = runCatching { URL(cdnUrl).path.lowercase() }.getOrDefault("")
            // Alguns hosts hclod/qzz entregam init.mp4 e fragmentos .m4s como text/css,
            // embora o corpo seja fMP4 válido. O WebView respeita esse MIME incorreto e o
            // hls.js encerra com fragLoadError; normalize antes de devolver a resposta.
            val contentType = when {
                mediaPath.endsWith(".mp4") || mediaPath.endsWith(".m4s") -> "video/mp4"
                mediaPath.endsWith(".vtt") -> "text/vtt"
                else -> upstreamContentType.substringBefore(';').trim()
                    .ifEmpty { "application/octet-stream" }
            }
            // Loga o tipo do provedor E o tipo entregue. Com apenas o primeiro, um
            // CDN que marca todo arquivo como text/css fazia a captura parecer um
            // defeito de reescrita, quando o corpo e fMP4 valido e ja e corrigido.
            val tipoNoLog = if (contentType != upstreamContentType.substringBefore(';').trim()) {
                "$upstreamContentType -> $contentType"
            } else {
                contentType
            }
            ObaLog.evento(
                ObaLog.Fase.CDN, "resposta",
                "status" to response.code,
                "host" to cdnHost,
                "arquivo" to ObaLog.arquivo(cdnUrl),
                "ct" to tipoNoLog,
                "bytes" to (response.header("Content-Length") ?: "stream"),
                "ms" to (System.currentTimeMillis() - comeco),
            )

            val headers = mutableMapOf(
                "Cache-Control" to "public, max-age=3600",
                "Access-Control-Allow-Origin" to "*",
                "Access-Control-Allow-Headers" to "Range",
            )
            response.header("Content-Range")?.let { headers["Content-Range"] = it }
            response.header("Content-Length")?.let { headers["Content-Length"] = it }

            // HTTP/2 não tem reasonPhrase — response.message é "" no OkHttp/H2,
            // e WebResourceResponse lança IllegalArgumentException se vazio.
            val reason = response.message.ifEmpty { "OK" }

            // Detecta M3U8 pelo Content-Type ou pela extensão na URL.
            // O hls.js resolve URIs relativas do manifesto contra a URL do documento
            // (obaflix.vercel.app), não contra a origem real do CDN. Por isso linhas como
            // "/hls/<token>" viram "https://obaflix.vercel.app/hls/<token>" → 404 →
            // levelLoadError. A correção: reescrever URIs relativas para absolutas (CDN)
            // antes de entregar o M3U8 ao hls.js. Depois de reescritas, as requisições
            // aos níveis/segmentos caem no branch 3 (host CDN) e seguem pelo fetchCdnDirect.
            val ct = upstreamContentType.lowercase()
            val urlLower = cdnUrl.lowercase()
            val parsedCdnUrl = runCatching { URL(cdnUrl) }.getOrNull()
            val isExtensionlessEmbedPlayerPlaylist = parsedCdnUrl != null &&
                (parsedCdnUrl.host == "embedplayer1.xyz" || parsedCdnUrl.host.endsWith(".embedplayer1.xyz") ||
                    parsedCdnUrl.host == "embedplayer2.xyz" || parsedCdnUrl.host.endsWith(".embedplayer2.xyz")) &&
                Regex("^/m(?:3|d)/", RegexOption.IGNORE_CASE).containsMatchIn(parsedCdnUrl.path)
            val isM3u8 = ct.contains("mpegurl") || ct.contains("m3u") ||
                urlLower.contains(".m3u8") || urlLower.contains(".txt") ||
                isExtensionlessEmbedPlayerPlaylist

            if (isM3u8) {
                val bodyText = response.body?.string() ?: run {
                    // Sem close() a conexao ficaria presa no pool ate o GC.
                    response.close()
                    ObaLog.alerta(ObaLog.Fase.MANIFESTO, "corpo_vazio", "host" to cdnHost)
                    return null
                }
                val normalized = bodyText.replace("\r\n", "\n").replace("\r", "\n")
                val cdnBase = cdnUrl.substring(0, cdnUrl.lastIndexOf("/") + 1)
                val cdnOrigin = try {
                    URL(cdnUrl).let { "${it.protocol}://${it.host}" }
                } catch (_: Exception) { "" }

                val absoluteUriScheme = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")

                fun resolvePlaylistUri(raw: String): String {
                    val value = raw.trim()
                    val resolved = when {
                        // http:, https:, data:, skd: e outros esquemas absolutos
                        absoluteUriScheme.containsMatchIn(value) -> value
                        // URL relativa ao protocolo
                        value.startsWith("//") -> "https:$value"
                        // URL relativa à raiz do CDN
                        value.startsWith("/") -> cdnOrigin + value
                        // URL relativa ao diretório atual do manifesto
                        else -> cdnBase + value
                    }
                    runCatching {
                        val mediaUrl = URL(resolved)
                        if (mediaUrl.protocol == "https") state.allowCdnHost(mediaUrl.host)
                    }
                    return resolved
                }

                val doubleQuotedUri = Regex(
                    "URI\\s*=\\s*\"([^\"]+)\"",
                    RegexOption.IGNORE_CASE,
                )
                val singleQuotedUri = Regex(
                    "URI\\s*=\\s*'([^']+)'",
                    RegexOption.IGNORE_CASE,
                )

                fun rewriteTagUris(line: String): String {
                    val doubleRewritten = doubleQuotedUri.replace(line) { match ->
                        "URI=\"${resolvePlaylistUri(match.groupValues[1])}\""
                    }
                    return singleQuotedUri.replace(doubleRewritten) { match ->
                        "URI='${resolvePlaylistUri(match.groupValues[1])}'"
                    }
                }

                val rewritten = normalized.split("\n").joinToString("\n") { line ->
                    val trimmed = line.trim()
                    when {
                        trimmed.isEmpty() -> line

                        // Mantém a tag, mas torna absolutas URLs presentes em
                        // EXT-X-MEDIA, EXT-X-KEY, EXT-X-MAP e I-FRAME-STREAM-INF.
                        trimmed.startsWith("#") -> rewriteTagUris(line)

                        // Linhas normais representam playlists ou segmentos.
                        else -> resolvePlaylistUri(trimmed)
                    }
                }
                ObaLog.evento(
                    ObaLog.Fase.MANIFESTO, "reescrito",
                    "linhas" to normalized.lines().size,
                    "master" to normalized.contains("#EXT-X-STREAM-INF"),
                    "segmentos" to Regex("#EXTINF").findAll(normalized).count(),
                    "host" to cdnHost,
                )
                headers.remove("Content-Length") // tamanho mudou após reescrita
                WebResourceResponse(
                    "application/vnd.apple.mpegurl", "UTF-8", response.code, reason,
                    headers, rewritten.toByteArray(Charsets.UTF_8).inputStream(),
                )
            } else {
                val body = response.body?.byteStream() ?: run {
                    response.close()
                    ObaLog.alerta(ObaLog.Fase.CDN, "corpo_vazio", "host" to cdnHost)
                    return null
                }
                WebResourceResponse(
                    contentType.substringBefore(";").trim(), "UTF-8", response.code, reason,
                    headers, body,
                )
            }
        } catch (e: Exception) {
            // Devolver null faz a WebView refazer a requisicao sozinha — e ela nao
            // tem como mandar Referer/Origin, entao o CDN responde 403. Registrar a
            // fase real da falha aqui e a unica forma de distinguir esse 403
            // derivado de um 403 legitimo do provedor.
            ObaLog.falha(
                ObaLog.Fase.CDN, "erro_rede", e,
                "host" to ObaLog.host(cdnUrl),
                "arquivo" to ObaLog.arquivo(cdnUrl),
                "diagnostico" to com.obaflix.bridge.NetworkDiagnostics.describe(e, cdnUrl),
            )
            null
        }
    }

    /**
     * Refaz a requisição do documento principal via OkHttp para remover o header CSP da
     * resposta, preservando a sessão do usuário.
     *
     * Limitação de WebView: `WebResourceRequest.requestHeaders` NUNCA inclui o header Cookie
     * (nem User-Agent) — a API do Android omite deliberadamente headers de credenciais dos
     * interceptors por design. Refazer o fetch sem repor esse header manualmente (como a
     * versão anterior deste arquivo fazia) resulta numa página carregada sem sessão, causando
     * erro de hidratação do Next.js (client renderiza autenticado, servidor responde
     * deslogado) — ver histórico em docs/android.md.
     *
     * Fix: lê os cookies atuais do domínio via CookieManager (a mesma fonte que o WebView usa
     * nativamente) e os injeta manualmente como header Cookie na requisição OkHttp. Qualquer
     * Set-Cookie devolvido pela resposta é sincronizado de volta no CookieManager, para que a
     * sessão do WebView permaneça consistente após esta requisição sintética.
     *
     * Accept-Encoding: o header é removido antes de enviar ao OkHttp para que o BridgeInterceptor
     * adicione seu próprio "Accept-Encoding: gzip" e faça a descompressão transparente. Isso é
     * necessário porque WebResourceResponse não aplica Content-Encoding ao body — se passarmos
     * bytes brotli/gzip crus, o WebView os trata como HTML literal e o React falha na hidratação.
     */
    private fun fetchDocumentWithoutCsp(original: WebResourceRequest): WebResourceResponse? {
        val urlStr = original.url.toString()
        return try {
            val cookieManager = CookieManager.getInstance()
            val cookies = cookieManager.getCookie(urlStr)

            val reqBuilder = Request.Builder().url(urlStr)
            original.requestHeaders.forEach { (k, v) -> reqBuilder.addHeader(k, v) }
            // Remove Accept-Encoding para que o OkHttp BridgeInterceptor adicione gzip e
            // descomprima o body automaticamente — WebResourceResponse não decodifica Content-Encoding.
            reqBuilder.removeHeader("Accept-Encoding")
            reqBuilder.removeHeader("User-Agent").addHeader("User-Agent", UA)
            if (!cookies.isNullOrEmpty()) {
                reqBuilder.removeHeader("Cookie").addHeader("Cookie", cookies)
            } else {
                ObaLog.evento(ObaLog.Fase.DOCUMENTO, "sem_cookies", "url" to ObaLog.url(urlStr))
            }

            val response = ObaflixApp.httpClient.newCall(reqBuilder.build()).execute()
            ObaLog.evento(
                ObaLog.Fase.DOCUMENTO, "resposta",
                "status" to response.code,
                "url" to ObaLog.url(urlStr),
                "autenticado" to !cookies.isNullOrEmpty(),
            )

            // Sincroniza Set-Cookie de volta no CookieManager — a resposta veio via OkHttp,
            // fora do fluxo nativo do WebView, então nada faria isso automaticamente.
            val setCookies = response.headers("Set-Cookie")
            if (setCookies.isNotEmpty()) {
                // Sinc para a URL original E para a URL final (caso OkHttp tenha seguido redirect)
                val finalUrl = response.request.url.toString()
                setCookies.forEach { cookieManager.setCookie(urlStr, it) }
                if (finalUrl != urlStr) setCookies.forEach { cookieManager.setCookie(finalUrl, it) }
                cookieManager.flush()
                ObaLog.evento(ObaLog.Fase.DOCUMENTO, "cookies_sincronizados", "qtd" to setCookies.size)
            }

            val contentType = response.header("Content-Type", "text/html")!!

            // OkHttp descomprimiu o body (gzip transparente via BridgeInterceptor).
            // Lemos como String para injetar o script de diagnóstico de erros JS.
            val bodyStr = response.body?.string() ?: return null

            // Sonda de diagnostico injetada no <head> do documento principal.
            //
            // O que ela resolve: as falhas de reproducao que importam acontecem no
            // JS (hls.js desiste, o <video> emite MediaError, uma Promise rejeita
            // sem handler) e nada disso chega ao logcat por conta propria. O
            // onConsoleMessage do WebChromeClient so ve o que alguem imprimiu.
            //
            // Sem overlay de propósito: a versao anterior desenhava o erro por cima
            // do player, e window.onerror disparado por falha de carregamento de
            // recurso (que no WebView entrega um Event, nao uma string) cobria o
            // video com "ERR:[object Object]".
            //
            // Tudo sai por _obaflixBridge.logDiag, que exige a mesma capability das
            // demais chamadas — uma pagina de terceiro dentro de um iframe nao
            // consegue injetar linha nenhuma no log.
            val debugScript = """<script>(function(){
var CAP='$bridgeCapability';
function envia(fase,ev,dados){
  try{
    var b=window._obaflixBridge;
    if(b&&b.logDiag)b.logDiag(CAP,fase,ev,JSON.stringify(dados||{}).slice(0,900));
  }catch(_){}
}
function sa(x){
  if(x==null)return String(x);
  var t=typeof x;
  if(t==='string'||t==='number'||t==='boolean')return String(x);
  if(x&&x.stack)return String(x.stack).slice(0,400);
  try{
    var visto=[];
    return JSON.stringify(x,function(k,v){
      if(typeof v==='object'&&v!==null){
        if(visto.indexOf(v)>=0)return'[circ]';
        visto.push(v);
      }
      return v;
    });
  }catch(_){return'['+t+']';}
}
// Só o host e o nome do arquivo: a query carrega token e assinatura do CDN.
function limpa(u){
  try{var p=new URL(u,location.href);
    var f=p.pathname.split('/').pop()||'/';
    return p.hostname+'/'+f;}catch(_){return'-';}
}

var reentrante=false;
var _erroOriginal=console.error;
console.error=function(){
  _erroOriginal.apply(console,arguments);
  if(reentrante)return;
  reentrante=true;
  try{
    var m=Array.prototype.slice.call(arguments).map(sa).join(' | ');
    if(m&&m.length>2)envia('player','console_error',{msg:m.slice(0,500)});
  }catch(_){}finally{reentrante=false;}
};

window.addEventListener('error',function(e){
  // Falha de recurso (img/script/link): o alvo é o elemento, não window.
  var alvo=e&&e.target;
  if(alvo&&alvo!==window&&alvo.tagName){
    envia('player','recurso_falhou',{
      tag:alvo.tagName,
      url:limpa(alvo.src||alvo.href||'')
    });
    return;
  }
  if(typeof e.message!=='string')return;
  envia('player','erro_js',{
    msg:e.message.slice(0,300),
    origem:limpa(e.filename||''),
    linha:e.lineno,
    pilha:e.error&&e.error.stack?String(e.error.stack).slice(0,300):''
  });
},true);

window.addEventListener('unhandledrejection',function(e){
  envia('player','promise_rejeitada',{motivo:sa(e&&e.reason).slice(0,400)});
});

// MediaError.code: 1 abortado, 2 rede, 3 decodificacao, 4 formato/fonte
// nao suportada. O 3 e o que aparece quando o CDN devolve fMP4 com o
// Content-Type errado; o 4, quando o manifesto veio vazio ou como HTML.
var NOME_ERRO_MIDIA={1:'ABORTADO',2:'REDE',3:'DECODIFICACAO',4:'FONTE_NAO_SUPORTADA'};

function estado(v){
  return {
    rede:v.networkState,
    pronto:v.readyState,
    tempo:Math.round((v.currentTime||0)*10)/10,
    duracao:isFinite(v.duration)?Math.round(v.duration):0,
    buffer:v.buffered&&v.buffered.length?Math.round(v.buffered.end(v.buffered.length-1)):0,
    fonte:limpa(v.currentSrc||'')
  };
}

var observados=new WeakSet();
function observar(v){
  if(!v||observados.has(v))return;
  observados.add(v);
  envia('player','video_anexado',{fonte:limpa(v.currentSrc||'')});

  v.addEventListener('error',function(){
    var e=v.error||{};
    var d=estado(v);
    d.codigo=e.code;
    d.tipo=NOME_ERRO_MIDIA[e.code]||'DESCONHECIDO';
    d.detalhe=(e.message||'').slice(0,200);
    envia('player','video_erro',d);
  });
  v.addEventListener('loadedmetadata',function(){envia('player','metadados',estado(v));});
  v.addEventListener('playing',function(){envia('player','reproduzindo',estado(v));});
  v.addEventListener('ended',function(){envia('player','fim',estado(v));});

  // Travamento: 'waiting' sozinho e normal (buffer enchendo). So vira sinal
  // quando o player fica esperando e o tempo nao anda por varios segundos.
  var esperandoDesde=0,ultimoTempo=-1,avisado=false;
  v.addEventListener('waiting',function(){
    if(!esperandoDesde){esperandoDesde=Date.now();ultimoTempo=v.currentTime;}
  });
  v.addEventListener('timeupdate',function(){
    if(v.currentTime!==ultimoTempo){esperandoDesde=0;avisado=false;ultimoTempo=v.currentTime;}
  });
  setInterval(function(){
    if(!esperandoDesde||avisado)return;
    if(Date.now()-esperandoDesde<8000)return;
    avisado=true;
    var d=estado(v);
    d.travadoMs=Date.now()-esperandoDesde;
    envia('player','travado',d);
  },2000);
}

function varrer(){
  var vs=document.getElementsByTagName('video');
  for(var i=0;i<vs.length;i++)observar(vs[i]);
}
varrer();
new MutationObserver(varrer).observe(document.documentElement,{childList:true,subtree:true});

// hls.js so existe depois que o bundle do player carrega, e a instancia nao e
// global. O gancho vai no prototipo: cobre qualquer instancia criada depois.
var tentativas=0;
var procura=setInterval(function(){
  if(++tentativas>60){clearInterval(procura);return;}
  var H=window.Hls;
  if(!H||!H.prototype||H.prototype.__obaGanchoInstalado)return;
  clearInterval(procura);
  H.prototype.__obaGanchoInstalado=true;
  var attachOriginal=H.prototype.attachMedia;
  H.prototype.attachMedia=function(midia){
    try{
      var hls=this;
      hls.on(H.Events.ERROR,function(_,dados){
        envia('player','hls_erro',{
          fatal:!!dados.fatal,
          tipo:dados.type,
          detalhe:dados.details,
          status:dados.response&&dados.response.code,
          url:limpa(dados.url||dados.frag&&dados.frag.url||'')
        });
      });
      hls.on(H.Events.MANIFEST_PARSED,function(_,dados){
        envia('player','hls_manifesto',{niveis:(dados.levels||[]).length});
      });
    }catch(_){}
    return attachOriginal.apply(this,arguments);
  };
},500);

envia('documento','sonda_ativa',{url:limpa(location.href)});
})();</script>"""

            // Kotlin Regex.replaceFirst só aceita String, não lambda — usa replace com flag.
            var headReplaced = false
            val modifiedHtml = Regex("<head>", RegexOption.IGNORE_CASE).replace(bodyStr) { m ->
                if (!headReplaced) { headReplaced = true; m.value + debugScript } else m.value
            }

            val body = modifiedHtml.toByteArray(Charsets.UTF_8).inputStream()

            val headers = response.headers.toMultimap()
                .filterKeys { key ->
                    !key.equals("content-security-policy", ignoreCase = true) &&
                    !key.equals("content-security-policy-report-only", ignoreCase = true) &&
                    !key.equals("set-cookie", ignoreCase = true) &&
                    // Content-Length muda após injeção do script; Content-Encoding já foi
                    // removido pelo OkHttp (decompressão transparente), mas filtramos por segurança.
                    !key.equals("content-length", ignoreCase = true) &&
                    !key.equals("content-encoding", ignoreCase = true)
                }
                .mapValues { it.value.joinToString(", ") }
                .toMutableMap()

            val reasonPhrase = response.message.ifEmpty { "OK" }
            WebResourceResponse(
                contentType.substringBefore(";").trim(), "UTF-8", response.code, reasonPhrase,
                headers, body,
            )
        } catch (e: Exception) {
            ObaLog.falha(ObaLog.Fase.DOCUMENTO, "erro_rede", e, "url" to ObaLog.url(urlStr))
            null
        }
    }
}
