package com.obaflix.player

import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
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

        // 1. Extração nativa (rola3/rola4/hide/lulu/rola2/wish/bolt/big) → StreamExtractor
        //    (usa OkHttp com IP do usuário) — ver PlayerExtractors.detectProvider().
        if (path == "/api/player/extract") {
            val embedUrl = request.url.getQueryParameter("url") ?: return null
            if (PlayerExtractors.detectProvider(embedUrl) != null) {
                Log.d(TAG, "[intercept/extract] → nativo: ${embedUrl.take(80)}")
                return try {
                    val result = runBlocking { StreamExtractor.extract(embedUrl) }
                    val tipo = if (result.stream.contains(".mp4")) "mp4" else "hls"
                    Log.d(TAG, "[intercept/extract] sucesso: tipo=$tipo stream=${result.stream.take(100)}")
                    val json = JSONObject().apply {
                        put("stream", result.stream)
                        put("tipo", tipo)
                        put("referer", result.referer)
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
                Log.d(TAG, "[intercept/proxy] manifest → CDN direto: ${cdnUrl.take(100)}")
                return fetchCdnDirect(cdnUrl, request)
            }
            // sig= ou sem native=1: deixa seguir para o proxy Vercel normal (não é rola3/4 nativo)
            return null
        }

        // 3. Requisições diretas ao MESMO host do CDN (segmentos, sub-playlists de áudio,
        //    chaves de criptografia) — o manifest do CDN referencia esses recursos com URL
        //    absoluta, e o hls.js os busca diretamente, fora do path /api/player/proxy.
        //    Sem este branch, essas requisições saem sem Referer/Origin/CORS → 403 do CDN.
        //    Equivale ao branch "isCdnReq" do onBeforeSendHeaders (main.js), que é universal
        //    porque Electron registra o listener para "*://*/*".
        val cdnHostname = ObaflixApp.playerState.cdnHostname
        if (cdnHostname != null && (host == cdnHostname || host.endsWith(".$cdnHostname"))) {
            Log.d(TAG, "[intercept/cdn] request direto ao CDN: ${request.url.toString().take(100)}")
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
            (host.contains("obaflix") || host.contains("vercel"))
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
                .addHeader("User-Agent", UA)
                // Headers necessários para CDNs com bot-detection — sem eles, alguns CDNs
                // retornam 403 porque a request não parece vir de um browser real.
                .addHeader("Accept", "*/*")
                .addHeader("Accept-Language", "pt-BR,pt;q=0.5,en-US;q=0.3,en;q=0.2")
                .addHeader("Sec-Fetch-Dest", "empty")
                .addHeader("Sec-Fetch-Mode", "cors")
                .addHeader("Sec-Fetch-Site", "cross-site")

            // Injeta Referer e Origin do embed se o CDN hostname corresponder
            val cdnHost = try { URL(cdnUrl).host } catch (_: Exception) { "" }
            val isCdnHost = state.cdnHostname != null &&
                (cdnHost == state.cdnHostname || cdnHost.endsWith(".${state.cdnHostname}"))
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
                Log.w(TAG, "[intercept/cdn] status não-2xx: ${response.code} ${response.message} — $cdnUrl")
            }

            val contentType = response.header("Content-Type", "application/octet-stream")!!
            val headers = mutableMapOf(
                "Cache-Control" to "public, max-age=3600",
                "Access-Control-Allow-Origin" to "*",
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
            val ct = contentType.lowercase()
            val urlLower = cdnUrl.lowercase()
            val isM3u8 = ct.contains("mpegurl") || ct.contains("m3u") ||
                urlLower.contains(".m3u8") || urlLower.contains(".txt")

            if (isM3u8) {
                val bodyText = response.body?.string() ?: return null
                val normalized = bodyText.replace("\r\n", "\n").replace("\r", "\n")
                val cdnBase = cdnUrl.substring(0, cdnUrl.lastIndexOf("/") + 1)
                val cdnOrigin = try {
                    URL(cdnUrl).let { "${it.protocol}://${it.host}" }
                } catch (_: Exception) { "" }

                val rewritten = normalized.split("\n").joinToString("\n") { line ->
                    val trimmed = line.trim()
                    when {
                        // Linhas vazias, comentários e tags EXT-X: inalteradas
                        trimmed.isEmpty() || trimmed.startsWith("#") -> line
                        // URI já absoluta: mantém (branch 3 vai interceptar se for CDN)
                        trimmed.startsWith("http://") || trimmed.startsWith("https://") -> line
                        // Protocol-relative: força https
                        trimmed.startsWith("//") -> "https:$trimmed"
                        // Root-relative (/hls/<token> etc): resolve contra a origem do CDN
                        trimmed.startsWith("/") -> cdnOrigin + trimmed
                        // Path-relative (segment.ts etc): resolve contra a base do CDN
                        else -> cdnBase + trimmed
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
            Log.e(TAG, "[intercept/cdn] erro ao buscar $cdnUrl: ${e.message}")
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
                """  try{window._obaflixBridge&&window._obaflixBridge.logError(msg.slice(0,300));}catch(_){}""" +
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
