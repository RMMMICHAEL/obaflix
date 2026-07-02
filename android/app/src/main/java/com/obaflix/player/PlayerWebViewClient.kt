package com.obaflix.player

import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.obaflix.ObaflixApp
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

    private fun isRola34Url(url: String): Boolean {
        return Regex("/(rola3|rola4)/").containsMatchIn(url)
            || url.contains("embedplayer")
            || url.contains("xn--kcksk7a2bl5le7b6doc1h3f")
    }

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? {
        val path = request.url.path ?: ""
        val host = request.url.host ?: ""

        // 1. Extração rola3/4 → StreamExtractor (usa OkHttp com IP do usuário)
        if (path == "/api/player/extract") {
            val embedUrl = request.url.getQueryParameter("url") ?: return null
            if (isRola34Url(embedUrl)) {
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
            val body = response.body?.byteStream() ?: return null
            val headers = mutableMapOf(
                "Cache-Control" to "public, max-age=3600",
                "Access-Control-Allow-Origin" to "*",
            )
            response.header("Content-Range")?.let { headers["Content-Range"] = it }
            response.header("Content-Length")?.let { headers["Content-Length"] = it }

            WebResourceResponse(
                contentType.substringBefore(";").trim(), "UTF-8", response.code, response.message,
                headers, body,
            )
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
     */
    private fun fetchDocumentWithoutCsp(original: WebResourceRequest): WebResourceResponse? {
        val urlStr = original.url.toString()
        return try {
            val cookieManager = CookieManager.getInstance()
            val cookies = cookieManager.getCookie(urlStr)

            val reqBuilder = Request.Builder().url(urlStr)
            original.requestHeaders.forEach { (k, v) -> reqBuilder.addHeader(k, v) }
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
                setCookies.forEach { cookieManager.setCookie(urlStr, it) }
                cookieManager.flush()
                Log.d(TAG, "[intercept/csp] ${setCookies.size} cookie(s) sincronizado(s)")
            }

            val contentType = response.header("Content-Type", "text/html")!!
            val body = response.body?.byteStream() ?: return null

            val headers = response.headers.toMultimap()
                .filterKeys { key ->
                    !key.equals("content-security-policy", ignoreCase = true) &&
                    !key.equals("content-security-policy-report-only", ignoreCase = true) &&
                    !key.equals("set-cookie", ignoreCase = true) // já sincronizado acima via CookieManager
                }
                .mapValues { it.value.joinToString(", ") }
                .toMutableMap()

            WebResourceResponse(
                contentType.substringBefore(";").trim(), "UTF-8", response.code, response.message,
                headers, body,
            )
        } catch (e: Exception) {
            Log.e(TAG, "[intercept/csp] erro ao buscar documento sem CSP: ${e.message}")
            null
        }
    }
}
