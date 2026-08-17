package com.obaflix.player

import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.net.Uri
import com.obaflix.BuildConfig
import com.obaflix.ObaflixApp
import com.obaflix.bridge.PlayerExtractors
import com.obaflix.bridge.StreamExtractor
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.URL

private const val TAG = "Obaflix"

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
    private val onPageReady: ((WebView) -> Unit)? = null,
) : WebViewClient() {

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
        Log.d(TAG, "[provider/subtitle] host=$host path=$path")
    }

    /**
     * Navegações que tiram o usuário da tela de servidores: a seta de voltar, que
     * leva para a página de episódio do provedor, e os botões de compartilhamento.
     *
     * A regra lista o que BLOQUEAR, não o que permitir — uma lista de permissão
     * derrubaria o desafio do Cloudflare, que navega frames para
     * challenges.cloudflare.com, e a troca para o host do servidor escolhido, que
     * muda de domínio no meio da cadeia.
     */
    private fun isProviderEscapeNavigation(uri: Uri): Boolean {
        val host = uri.host.orEmpty().lowercase()
        if (Regex("""(^|\.)(t\.me|telegram\.me|telegram\.org|wa\.me|whatsapp\.com|facebook\.com|twitter\.com|x\.com)$""")
                .containsMatchIn(host)
        ) return true

        val isSuperflix = host == "superflixapi.pro" || host.endsWith(".superflixapi.pro")
        if (!isSuperflix) return false

        val path = uri.path.orEmpty()
        // O app entra sempre pela forma numérica (/serie/{tmdbId}/{t}/{ep}); o
        // provedor navega internamente por slug (/serie/dexter-new-blood). É isso
        // que separa a nossa entrada do "voltar" dele.
        val belongsToPlayer = path.startsWith("/player/", ignoreCase = true) ||
            path.startsWith("/cdn-cgi/", ignoreCase = true) ||
            uri.getQueryParameter("cfv") != null ||
            Regex("""^/(?:serie|filme)/\d+""", RegexOption.IGNORE_CASE).containsMatchIn(path)
        return !belongsToPlayer
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val uri = request.url
        val providerHost = uri.host.orEmpty().lowercase()
        if ((providerHost.endsWith("superflixapi.pro") || providerHost.contains("vizero") ||
                providerHost.contains("warezcdn")) && !uri.path.orEmpty().startsWith("/cdn-cgi/")
        ) {
            // Sem query para não registrar tokens; host+path identifica a rota que
            // terminou em 404 caso o provedor mude novamente.
            Log.d(
                TAG,
                "[provider/navigation] main=${request.isForMainFrame} url=${uri.scheme}://$providerHost${uri.path}",
            )
        }
        if (!request.isForMainFrame) {
            if (isProviderEscapeNavigation(uri)) {
                Log.d(TAG, "[provider/navigation] bloqueada: $providerHost${uri.path}")
                return true
            }
            return false
        }
        if (uri.scheme == "https" && uri.host == allowedAppHost) return false
        if (uri.scheme == "http" || uri.scheme == "https") {
            Log.w(TAG, "[navigation] bloqueada navegação externa no frame principal: ${uri.host}")
        }
        return true
    }

    override fun onPageFinished(view: WebView, url: String) {
        super.onPageFinished(view, url)
        onPageReady?.invoke(view)
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

        superflixMediaKind(request)?.let { kind ->
            val referer = header(request, "Referer")
            ObaflixApp.playerState.observeSuperflixMedia(request.url.toString(), referer, kind)
            Log.d(TAG, "[provider/media] kind=$kind host=$host path=$path")
        }
        observeSuperflixSubtitle(request)

        val isSuperflixSignedRoute = host.endsWith("superflixapi.pro") &&
            (request.url.getQueryParameter("cfv") != null || path.startsWith("/player/redirect"))
        if (isSuperflixSignedRoute || host.contains("vizero") || host.contains("warezcdn")) {
            ObaflixApp.playerState.observeSuperflixUrl(request.url.toString())
            Log.d(TAG, "[provider/observed] host=$host path=$path")
        }

        // 1. Extração nativa (rola3/rola4/hide/lulu/rola2/wish/bolt/big) → StreamExtractor
        //    (usa OkHttp com IP do usuário) — ver PlayerExtractors.detectProvider().
        if (path == "/api/player/extract") {
            val embedUrl = request.url.getQueryParameter("url") ?: return null
            if (PlayerExtractors.detectProvider(embedUrl) != null) {
                Log.d(TAG, "[intercept/extract] → nativo")
                return try {
                    val result = runBlocking { StreamExtractor.extract(embedUrl) }
                    val tipo = if (result.stream.contains(".mp4")) "mp4" else "hls"
                    Log.d(TAG, "[intercept/extract] sucesso: tipo=$tipo")
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
                    Log.e(TAG, "[intercept/extract] falhou: ${e.message}")
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
                Log.d(TAG, "[intercept/proxy] manifest → CDN direto")
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
            Log.d(TAG, "[intercept/cdn] request direto ao CDN")
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
            Log.d(TAG, "[intercept/csp] documento principal, removendo CSP: $host$path")
            return fetchDocumentWithoutCsp(request)
        }

        return null
    }

    private fun fetchCdnDirect(cdnUrl: String, original: WebResourceRequest): WebResourceResponse? {
        return try {
            val state = ObaflixApp.playerState
            val reqBuilder = Request.Builder().url(cdnUrl).get()
                .addHeader("User-Agent", ObaflixApp.webViewUserAgent ?: UA)
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

            // Injeta Referer e Origin do embed se o CDN hostname corresponder
            val cdnHost = try { URL(cdnUrl).host } catch (_: Exception) { "" }
            val isCdnHost = state.isAllowedCdnHost(cdnHost)
            if (isCdnHost && state.embedReferer != null) {
                reqBuilder.addHeader("Referer", state.embedReferer!!)
                try {
                    val embedOrigin = URL(state.embedReferer!!).let { "${it.protocol}://${it.host}" }
                    reqBuilder.addHeader("Origin", embedOrigin)
                } catch (_: Exception) { }
            } else {
                Log.w(TAG, "[intercept/cdn] sem Referer/Origin injetado (isCdnHost=$isCdnHost, embedReferer=${state.embedReferer != null}) para $cdnHost")
            }

            original.requestHeaders["Range"]?.let { reqBuilder.addHeader("Range", it) }

            val response = ObaflixApp.httpClient.newCall(reqBuilder.build()).execute()
            Log.d(TAG, "[intercept/cdn] resposta ${response.code} de $cdnHost (${response.header("Content-Type") ?: "?"})")

            if (!response.isSuccessful) {
                Log.w(TAG, "[intercept/cdn] status não-2xx: ${response.code} ${response.message}")
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
                val bodyText = response.body?.string() ?: return null
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
                Log.d(TAG, "[intercept/cdn] m3u8 reescrito (${normalized.lines().size} linhas): base=$cdnBase")
                headers.remove("Content-Length") // tamanho mudou após reescrita
                WebResourceResponse(
                    "application/vnd.apple.mpegurl", "UTF-8", response.code, reason,
                    headers, rewritten.toByteArray(Charsets.UTF_8).inputStream(),
                )
            } else {
                val body = response.body?.byteStream() ?: return null
                WebResourceResponse(
                    contentType.substringBefore(";").trim(), "UTF-8", response.code, reason,
                    headers, body,
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "[intercept/cdn] erro ao buscar mídia: ${e.javaClass.simpleName}")
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
                Log.d(TAG, "[intercept/csp] sem cookies para $urlStr (usuário ainda não autenticado)")
            }

            val response = ObaflixApp.httpClient.newCall(reqBuilder.build()).execute()
            Log.d(TAG, "[intercept/csp] resposta ${response.code}, cookies=${!cookies.isNullOrEmpty()}")

            // Sincroniza Set-Cookie de volta no CookieManager — a resposta veio via OkHttp,
            // fora do fluxo nativo do WebView, então nada faria isso automaticamente.
            val setCookies = response.headers("Set-Cookie")
            if (setCookies.isNotEmpty()) {
                // Sinc para a URL original E para a URL final (caso OkHttp tenha seguido redirect)
                val finalUrl = response.request.url.toString()
                setCookies.forEach { cookieManager.setCookie(urlStr, it) }
                if (finalUrl != urlStr) setCookies.forEach { cookieManager.setCookie(finalUrl, it) }
                cookieManager.flush()
                Log.d(TAG, "[intercept/csp] ${setCookies.size} cookie(s) sincronizado(s)")
            }

            val contentType = response.header("Content-Type", "text/html")!!

            // OkHttp descomprimiu o body (gzip transparente via BridgeInterceptor).
            // Lemos como String para injetar o script de diagnóstico de erros JS.
            val bodyStr = response.body?.string() ?: return null

            // Script de diagnóstico: captura erros JS e envia via Toast/logcat.
            // SEM overlay — o overlay bloqueava o player quando window.onerror era acionado
            // com um Event object (não uma string) por falhas de carregamento de recursos no
            // Android WebView, resultando em 'ERR:[object Object]' sobre o vídeo.
            val debugScript = """<script>(function(){""" +
                """var _o=console.error;""" +
                // sa(): serializa qualquer valor, com suporte a refs circulares via replacer.
                // Evita "[object Object]" mesmo para objetos do hls.js/JW Player com ciclos.
                """function sa(x){""" +
                """  if(x==null)return String(x);""" +
                """  if(typeof x==='string'||typeof x==='number'||typeof x==='boolean')return String(x);""" +
                """  if(x&&x.stack)return x.stack;""" +
                """  try{""" +
                """    var seen=[];""" +
                """    return JSON.stringify(x,function(k,v){""" +
                """      if(typeof v==='object'&&v!==null){""" +
                """        if(seen.indexOf(v)>=0)return'[circ]';""" +
                """        seen.push(v);""" +
                """      }""" +
                """      return v;""" +
                """    });""" +
                """  }catch(_){return'['+typeof x+']';}""" +
                """}""" +
                """function toast(msg){""" +
                """  try{console.debug('[native-debug] '+msg.slice(0,300));}catch(_){}""" +
                """}""" +
                // console.error: Toast + logcat original. Sem overlay, sem recursão.
                """var _b=false;""" +
                """console.error=function(){""" +
                """  _o.apply(console,arguments);""" +
                """  if(_b)return;_b=true;""" +
                """  try{var m=Array.from(arguments).map(sa).join(' | ');""" +
                """  if(m&&m.length>2)toast('[JS:err] '+m);}catch(_){}finally{_b=false;}""" +
                """};""" +
                // window.onerror: ignora resource errors (m não é string = ErrorEvent do WebView).
                // Só envia Toast para erros JS reais com source + Error object.
                """window.onerror=function(m,s,l,c,e){""" +
                """  if(typeof m!=='string')return false;""" +
                """  try{toast('[ERR] '+m+(s?' @'+s+':'+l:'')+(e&&e.stack?'\n'+e.stack.slice(0,150):''));}catch(_){}""" +
                """  return false;};""" +
                """})();</script>"""

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
            Log.e(TAG, "[intercept/csp] erro ao buscar documento sem CSP: ${e.message}")
            null
        }
    }
}
