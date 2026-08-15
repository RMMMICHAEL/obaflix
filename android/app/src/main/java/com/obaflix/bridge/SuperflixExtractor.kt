package com.obaflix.bridge

import android.util.Log
import android.webkit.CookieManager
import com.obaflix.ObaflixApp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.net.URLDecoder
import java.util.Base64

private const val SUPERFLIX_TAG = "Obaflix/Superflix"
private const val SUPERFLIX_TIMEOUT_HOPS = 7

/** Resultado nativo com Referer opcional para o CDN final. */
data class NativeExtractResult(
    val stream: String,
    val referer: String?,
    val subtitles: List<SubtitleTrack> = emptyList(),
)

data class SubtitleTrack(
    val file: String,
    val label: String = "Português",
)

/**
 * Extrai SuperFlix usando apenas o IP do aparelho:
 * SuperFlix -> Vizero -> WarezCDN -> player/source -> MP4/HLS final.
 *
 * Não usa Vercel e sempre refaz a cadeia completa quando chamado novamente,
 * gerando tokens novos para a recuperação automática do CustomPlayer.
 */
object SuperflixExtractor {

    private const val UA =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/122.0.0.0 Mobile Safari/537.36 ObaflixApp/1.0"

    private class CloudflareChallengeException : Exception(
        "SuperFlix aguardando validação do Cloudflare"
    )

    private fun userAgent(): String = ObaflixApp.webViewUserAgent ?: UA

    private fun findSubtitleTracks(html: String, baseUrl: String): List<SubtitleTrack> {
        val normalized = normalizeHtml(html)
        val found = linkedMapOf<String, SubtitleTrack>()
        fun add(raw: String?, label: String? = null) {
            val file = resolveUrl(raw, baseUrl) ?: return
            if (!Regex("""\.(?:vtt|srt|ass|ssa)(?:$|\?)""", RegexOption.IGNORE_CASE).containsMatchIn(file)) return
            found.putIfAbsent(file, SubtitleTrack(file, label?.takeIf { it.isNotBlank() } ?: "Português"))
        }

        Regex("""<track\b[^>]*>""", RegexOption.IGNORE_CASE).findAll(normalized).forEach { match ->
            val tag = match.value
            val src = Regex("""\bsrc=["']([^"']+)["']""", RegexOption.IGNORE_CASE).find(tag)?.groupValues?.get(1)
            val label = Regex("""\blabel=["']([^"']+)["']""", RegexOption.IGNORE_CASE).find(tag)?.groupValues?.get(1)
            add(src, label)
        }
        Regex("""["'](https?://[^"']+\.(?:vtt|srt|ass|ssa)(?:\?[^"']*)?)["']""", RegexOption.IGNORE_CASE)
            .findAll(normalized).forEach { add(it.groupValues[1]) }
        return found.values.toList()
    }

    private data class HttpResult(
        val url: String,
        val status: Int,
        val headers: Headers,
        val body: String,
    )

    private data class Page(
        val url: String,
        val html: String,
    )

    private data class SourceCandidate(
        val id: String,
        val score: Int,
        val index: Int,
    )

    private class CookieStore {
        private data class Cookie(
            val domain: String,
            val name: String,
            val value: String,
        )

        private val values = linkedMapOf<String, Cookie>()

        fun seed(url: String, cookieHeader: String?) {
            if (cookieHeader.isNullOrBlank()) return
            val host = try { URL(url).host.lowercase() } catch (_: Exception) { return }
            cookieHeader.split(";").forEach { raw ->
                val part = raw.trim()
                val eq = part.indexOf('=')
                if (eq <= 0) return@forEach
                val name = part.substring(0, eq)
                val value = part.substring(eq + 1)
                values["$host|$name"] = Cookie(host, name, value)
            }
        }

        fun absorb(url: String, setCookieHeaders: List<String>) {
            val host = try { URL(url).host.lowercase() } catch (_: Exception) { return }
        for (raw in setCookieHeaders) {
                val parts = raw.split(";").map { it.trim() }.toMutableList()
                if (parts.isEmpty()) continue
                val first = parts.removeAt(0)
                val eq = first.indexOf('=')
                if (eq <= 0) continue
                val name = first.substring(0, eq)
                val value = first.substring(eq + 1)
                var domain = host
                for (attribute in parts) {
                    val attrEq = attribute.indexOf('=')
                    if (attrEq <= 0) continue
                    val key = attribute.substring(0, attrEq)
                    if (key.equals("domain", ignoreCase = true)) {
                        domain = attribute.substring(attrEq + 1).removePrefix(".").lowercase()
                    }
                }
                values["$domain|$name"] = Cookie(domain, name, value)
                // Compartilha cookies novos com o WebView. Isso mantém a sessão do
                // desafio e a extração OkHttp no mesmo contexto do aplicativo.
                runCatching { CookieManager.getInstance().setCookie(url, raw) }
            }
        }

        fun header(url: String): String? {
            val host = try { URL(url).host.lowercase() } catch (_: Exception) { return null }
            val cookie = values.values
                .filter { host == it.domain || host.endsWith(".${it.domain}") }
                .joinToString("; ") { "${it.name}=${it.value}" }
            return cookie.takeIf { it.isNotEmpty() }
        }
    }

    private fun log(step: String, detail: String = "") {
        Log.d(SUPERFLIX_TAG, "[$step] $detail")
    }

    private fun safeUrl(raw: String): String = try {
        URL(raw).let { "${it.host}${it.path}" }.take(120)
    } catch (_: Exception) {
        raw.substringBefore('?').take(120)
    }

    private fun normalizeHtml(text: String): String = text
        .replace("\\u0026", "&", ignoreCase = true)
        .replace("\\u003d", "=", ignoreCase = true)
        .replace("\\u002f", "/", ignoreCase = true)
        .replace("\\/", "/")
        .replace("&amp;", "&", ignoreCase = true)
        .replace("&#x2f;", "/", ignoreCase = true)
        .replace("&#47;", "/")
        .replace("&quot;", "\"", ignoreCase = true)
        .replace("&#39;", "'")

    private fun resolveUrl(candidate: String?, baseUrl: String): String? {
        if (candidate.isNullOrBlank()) return null
        var value = normalizeHtml(candidate).trim().trim('"', '\'')
        return try {
            URL(URL(baseUrl), value).toString()
        } catch (_: Exception) {
            try {
                value = URLDecoder.decode(value, "UTF-8")
                URL(URL(baseUrl), value).toString()
            } catch (_: Exception) {
                null
            }
        }
    }

    private fun isChainHost(hostname: String): Boolean {
        val host = hostname.lowercase()
        return host == "superflixapi.pro" || host.endsWith(".superflixapi.pro") ||
            host.contains("vizero") || host.contains("warezcdn")
    }

    private fun isCloudflareChallenge(html: String): Boolean {
        val text = html.lowercase()
        return text.contains("name=\"cf_embed_challenge\"") ||
            text.contains("name='cf_embed_challenge'") ||
            text.contains("turnstilesitekey") ||
            (text.contains("<title>verificação</title>") && text.contains("cf-turnstile")) ||
            text.contains("cf_chl_opt") || text.contains("challenge-running") ||
            text.contains("just a moment...")
    }

    private fun collectChainUrls(html: String, baseUrl: String): List<String> {
        val normalized = normalizeHtml(html)
        val found = linkedSetOf<String>()

        fun add(raw: String) {
            val absolute = resolveUrl(raw, baseUrl) ?: return
            val parsed = try { URL(absolute) } catch (_: Exception) { return }
            // Scripts do desafio Cloudflare pertencem ao mesmo host, mas não são
            // páginas da cadeia SuperFlix/Vizero/WarezCDN.
            if (parsed.path.startsWith("/cdn-cgi/", ignoreCase = true)) return
            if (isChainHost(parsed.host)) found.add(absolute)
        }

        Regex("""(?:src|data-src|href|data-url)\s*=\s*["']([^"']+)["']""", RegexOption.IGNORE_CASE)
            .findAll(normalized)
            .forEach { add(it.groupValues[1]) }

        Regex("""https?://[^\s"'<>\\]+""", RegexOption.IGNORE_CASE)
            .findAll(normalized)
            .forEach { add(it.value) }

        fun score(url: String): Int {
            val parsed = try { URL(url) } catch (_: Exception) { return 0 }
            var value = 0
            if (parsed.host.contains("warezcdn")) value += 100
            if (parsed.query?.contains("cfv=") == true) value += 100
            if (parsed.host.contains("vizero")) value += 50
            if (parsed.path.contains("/player/")) value -= 30
            return value
        }

        return found.sortedByDescending(::score)
    }

    private fun decodeTokenPayload(token: String): JSONObject? = try {
        val part = token.substringBefore('.')
        val padded = part + "=".repeat((4 - part.length % 4) % 4)
        val decoded = Base64.getUrlDecoder().decode(padded)
        JSONObject(String(decoded, Charsets.UTF_8))
    } catch (_: Exception) {
        null
    }

    private fun findPageToken(html: String): String? {
        val normalized = normalizeHtml(html)
        val explicit = listOf(
            Regex("""(?:page_token|pageToken)\s*[:=]\s*["']([^"']+)["']""", RegexOption.IGNORE_CASE),
            Regex("""name=["']page_token["'][^>]*value=["']([^"']+)["']""", RegexOption.IGNORE_CASE),
            Regex("""value=["']([^"']+)["'][^>]*name=["']page_token["']""", RegexOption.IGNORE_CASE),
            Regex("""data-page-token=["']([^"']+)["']""", RegexOption.IGNORE_CASE),
            Regex("""page_token=([^&"'\s<]+)""", RegexOption.IGNORE_CASE),
        )
        for (pattern in explicit) {
            val value = pattern.find(normalized)?.groupValues?.getOrNull(1)
            if (!value.isNullOrBlank()) return try { URLDecoder.decode(value, "UTF-8") } catch (_: Exception) { value }
        }

        val tokenPattern = Regex("""eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,}""")
        for (match in tokenPattern.findAll(normalized)) {
            val payload = decodeTokenPayload(match.value) ?: continue
            if (payload.has("embed_content_path") || payload.has("embed_context_host") || payload.has("native_title")) {
                return match.value
            }
        }
        return null
    }

    private fun sourceScore(id: String, context: String): Int {
        val text = context.lowercase()
        var score = if (id.startsWith("native_media:")) 100 else 0
        if (Regex("""dublad|portugu|pt-br""").containsMatchIn(text)) score += 40
        if (Regex("""legend|subtitle|\bleg\b""").containsMatchIn(text)) score -= 10
        if (Regex("""full\s*hd|1080|\bhd\b""").containsMatchIn(text)) score += 5
        return score
    }

    private fun findSourceIds(html: String): List<String> {
        val normalized = normalizeHtml(html)
        val found = linkedMapOf<String, SourceCandidate>()

        fun add(id: String, index: Int) {
            val clean = id.trim()
            if (!Regex("""^(?:native_media:)?\d+$""").matches(clean)) return
            val from = maxOf(0, index - 300)
            val to = minOf(normalized.length, index + 300)
            val score = sourceScore(clean, normalized.substring(from, to))
            val previous = found[clean]
            if (previous == null || score > previous.score) {
                found[clean] = SourceCandidate(clean, score, index)
            }
        }

        Regex("""native_media:\d+""", RegexOption.IGNORE_CASE).findAll(normalized)
            .forEach { add(it.value, it.range.first) }

        val patterns = listOf(
            Regex("""(?:video[_-]?id|data-video-id|data-player-id|data-source-id|data-id)\s*[:=]\s*["']?((?:native_media:)?\d+)""", RegexOption.IGNORE_CASE),
            Regex("""name=["']video_id["'][^>]*value=["']((?:native_media:)?\d+)["']""", RegexOption.IGNORE_CASE),
            Regex("""value=["']((?:native_media:)?\d+)["'][^>]*name=["']video_id["']""", RegexOption.IGNORE_CASE),
        )
        for (pattern in patterns) {
            pattern.findAll(normalized).forEach { add(it.groupValues[1], it.range.first) }
        }

        return found.values
            .sortedWith(compareByDescending<SourceCandidate> { it.score }.thenBy { it.index })
            .map { it.id }
    }

    private fun findNativeMediaSource(html: String, baseUrl: String): String? {
        val normalized = normalizeHtml(html)
        val arrayMatch = Regex("""var\s+SOURCES\s*=\s*(\[[\s\S]*?\])\s*;""", RegexOption.IGNORE_CASE)
            .find(normalized)
        if (arrayMatch != null) {
            try {
                val sources = JSONArray(arrayMatch.groupValues[1])
                for (index in 0 until sources.length()) {
                    val source = sources.optJSONObject(index) ?: continue
                    val resolved = resolveUrl(source.optString("src"), baseUrl)
                    if (resolved?.contains("/player/native/media-source") == true) return resolved
                }
            } catch (_: Exception) { }
        }

        val direct = Regex("""["'](https?://[^"']+/player/native/media-source[^"']*)["']""", RegexOption.IGNORE_CASE)
            .find(normalized)?.groupValues?.getOrNull(1)
        return resolveUrl(direct, baseUrl)
    }

    private fun findDirectMedia(html: String, baseUrl: String): String? {
        val normalized = normalizeHtml(html)
        val patterns = listOf(
            Regex("""["'](https?://[^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']""", RegexOption.IGNORE_CASE),
            Regex("""["'](https?://[^"']+/cdn/hls/[^"']+/master\.txt(?:\?[^"']*)?)["']""", RegexOption.IGNORE_CASE),
            Regex("""(?:file|src|source)\s*[:=]\s*["'](https?://[^"']+)["']""", RegexOption.IGNORE_CASE),
        )
        for (pattern in patterns) {
            val candidate = pattern.find(normalized)?.groupValues?.getOrNull(1)
            resolveUrl(candidate, baseUrl)?.let { return it }
        }
        return null
    }

    private fun secFetchSite(url: String, referer: String?): String {
        if (referer.isNullOrBlank()) return "none"
        return try {
            val target = URL(url)
            val source = URL(referer)
            if (target.protocol == source.protocol && target.host == source.host && target.port == source.port) {
                "same-origin"
            } else {
                "cross-site"
            }
        } catch (_: Exception) {
            "cross-site"
        }
    }

    private suspend fun requestOnce(
        client: OkHttpClient,
        cookies: CookieStore,
        url: String,
        referer: String? = null,
        method: String = "GET",
        body: RequestBody? = null,
        accept: String = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        dest: String = "iframe",
        mode: String = "navigate",
        extraHeaders: Map<String, String> = emptyMap(),
        readBody: Boolean = true,
    ): HttpResult = withContext(Dispatchers.IO) {
        val builder = Request.Builder()
            .url(url)
            .addHeader("User-Agent", userAgent())
            .addHeader("Accept", accept)
            .addHeader("Accept-Language", "pt-BR,pt;q=0.7,en-US;q=0.3,en;q=0.2")
            .addHeader("Sec-Fetch-Dest", dest)
            .addHeader("Sec-Fetch-Mode", mode)
            .addHeader("Sec-Fetch-Site", secFetchSite(url, referer))

        if (!referer.isNullOrBlank()) builder.addHeader("Referer", referer)
        cookies.header(url)?.let { builder.addHeader("Cookie", it) }
        extraHeaders.forEach { (name, value) -> builder.header(name, value) }

        when (method.uppercase()) {
            "POST" -> builder.post(body ?: FormBody.Builder().build())
            "HEAD" -> builder.head()
            else -> builder.get()
        }

        client.newCall(builder.build()).execute().use { response ->
            cookies.absorb(url, response.headers.values("Set-Cookie"))
            val text = if (readBody) response.body?.string().orEmpty() else ""
            HttpResult(url, response.code, response.headers, text)
        }
    }

    private suspend fun fetchPage(
        client: OkHttpClient,
        cookies: CookieStore,
        startUrl: String,
        referer: String?,
        methodStart: String = "GET",
        bodyStart: RequestBody? = null,
        extraHeadersStart: Map<String, String> = emptyMap(),
    ): Page {
        var url = startUrl
        var currentReferer = referer
        var method = methodStart
        var body = bodyStart
        var extraHeaders = extraHeadersStart

        repeat(SUPERFLIX_TIMEOUT_HOPS) {
            val result = requestOnce(
                client = client,
                cookies = cookies,
                url = url,
                referer = currentReferer,
                method = method,
                body = body,
                extraHeaders = extraHeaders,
            )
            if (result.status in 300..399) {
                val location = result.headers["Location"]
                    ?: throw Exception("redirect ${result.status} sem Location em ${safeUrl(url)}")
                val next = resolveUrl(location, url)
                    ?: throw Exception("Location inválido em ${safeUrl(url)}")
                currentReferer = url
                url = next
                if (result.status == 303 || ((result.status == 301 || result.status == 302) && method == "POST")) {
                    method = "GET"
                    body = null
                    extraHeaders = emptyMap()
                }
            } else {
                if (result.status !in 200..299) throw Exception("HTTP ${result.status} em ${safeUrl(url)}")
                return Page(url, result.body)
            }
        }
        throw Exception("redirecionamentos demais em ${safeUrl(startUrl)}")
    }

    private suspend fun resolveWarezPage(
        client: OkHttpClient,
        cookies: CookieStore,
        embedUrl: String,
        initialReferer: String? = com.obaflix.BuildConfig.OBAFLIX_URL + "/",
    ): Page {
        var current = embedUrl
        var referer: String? = initialReferer
        val visited = linkedSetOf<String>()

        repeat(SUPERFLIX_TIMEOUT_HOPS) { hop ->
            if (!visited.add(current)) throw Exception("loop na cadeia SuperFlix/Vizero/WarezCDN")
            val page = fetchPage(client, cookies, current, referer)
            val parsed = URL(page.url)
            log("page", "hop=$hop url=${safeUrl(page.url)} bytes=${page.html.length}")

            if (isCloudflareChallenge(page.html)) {
                throw CloudflareChallengeException()
            }

            val delegatedProvider = PlayerExtractors.detectProvider(page.url)
            if (delegatedProvider != null && delegatedProvider != "superflix") return page

            if (parsed.host.contains("warezcdn") && findPageToken(page.html) != null) return page

            val candidates = collectChainUrls(page.html, page.url).filterNot { visited.contains(it) }
            val next = candidates.firstOrNull {
                try {
                    val candidate = URL(it)
                    candidate.host.contains("warezcdn") && candidate.query?.contains("cfv=") == true
                } catch (_: Exception) { false }
            } ?: candidates.firstOrNull()

            if (next == null) {
                if (findPageToken(page.html) != null) return page
                throw Exception("iframe/redirect WarezCDN não encontrado em ${safeUrl(page.url)}")
            }
            referer = page.url
            current = next
        }
        throw Exception("cadeia SuperFlix excedeu o limite de páginas")
    }

    private suspend fun postSource(
        client: OkHttpClient,
        cookies: CookieStore,
        warezPage: Page,
        pageToken: String,
        sourceId: String,
        host: String,
    ): String {
        val pageUrl = URL(warezPage.url)
        val origin = "${pageUrl.protocol}://${pageUrl.host}"
        val endpoint = "$origin/player/source?host=${java.net.URLEncoder.encode(host, "UTF-8")}"
        val form = FormBody.Builder()
            .add("video_id", sourceId)
            .add("page_token", pageToken)
            .add("host", host)
            .add("site", host)
            .add("_token", "")
            .build()

        val result = requestOnce(
            client = client,
            cookies = cookies,
            url = endpoint,
            referer = warezPage.url,
            method = "POST",
            body = form,
            accept = "*/*",
            dest = "empty",
            mode = "cors",
            extraHeaders = mapOf(
                "Origin" to origin,
                "X-Requested-With" to "XMLHttpRequest",
            ),
        )
        if (result.status !in 200..299) throw Exception("player/source HTTP ${result.status}")
        val json = try { JSONObject(result.body) } catch (_: Exception) {
            throw Exception("player/source retornou JSON inválido")
        }
        val videoUrl = json.optJSONObject("data")?.optString("video_url")
            ?.takeIf { it.isNotBlank() }
            ?: json.optString("video_url").takeIf { it.isNotBlank() }
            ?: throw Exception("video_url ausente em player/source")
        return resolveUrl(videoUrl, endpoint) ?: throw Exception("video_url inválida")
    }

    private suspend fun resolveSource(
        client: OkHttpClient,
        cookies: CookieStore,
        targetUrl: String,
        warezPageUrl: String,
    ): NativeExtractResult {
        val first = requestOnce(
            client = client,
            cookies = cookies,
            url = targetUrl,
            referer = warezPageUrl,
            readBody = false,
        )

        val resolvedUrl = if (first.status in 300..399) {
            resolveUrl(first.headers["Location"], targetUrl)
                ?: throw Exception("player/redirect sem Location válido")
        } else {
            if (first.status !in 200..299) throw Exception("player/redirect HTTP ${first.status}")
            targetUrl
        }

        val parsed = URL(resolvedUrl)
        log("target", safeUrl(resolvedUrl))

        if (parsed.path.contains("/player/native/media/")) {
            val mediaPage = fetchPage(client, cookies, resolvedUrl, warezPageUrl)
            val mediaSource = findNativeMediaSource(mediaPage.html, mediaPage.url)
                ?: throw Exception("media-source não encontrado no player nativo")
            val subtitles = findSubtitleTracks(mediaPage.html, mediaPage.url)

            val mediaResponse = requestOnce(
                client = client,
                cookies = cookies,
                url = mediaSource,
                referer = mediaPage.url,
                accept = "*/*",
                dest = "video",
                mode = "no-cors",
                extraHeaders = mapOf("Range" to "bytes=0-0"),
                readBody = false,
            )

            if (mediaResponse.status in 300..399) {
                val finalUrl = resolveUrl(mediaResponse.headers["Location"], mediaSource)
                    ?: throw Exception("media-source sem Location final")
                return NativeExtractResult(finalUrl, null, subtitles)
            }

            val contentType = mediaResponse.headers["Content-Type"].orEmpty()
            if (mediaResponse.status in 200..299 &&
                (contentType.contains("video/mp4", ignoreCase = true) || contentType.contains("octet-stream", ignoreCase = true))
            ) {
                return NativeExtractResult(mediaSource, mediaPage.url, subtitles)
            }
            throw Exception("media-source HTTP ${mediaResponse.status}")
        }

        if (parsed.host.contains("embedplayer") || parsed.host.contains("xn--kcksk7a2bl5le7b6doc1h3f") ||
            Regex("""/video/[a-f0-9]{16,}""", RegexOption.IGNORE_CASE).containsMatchIn(parsed.path)
        ) {
            val warez = URL(warezPageUrl)
            val r = "${warez.protocol}://${warez.host}/"
            val stream = PlayerExtractors.extractEmbedPlayer(resolvedUrl, r)
            return NativeExtractResult(stream, resolvedUrl)
        }

        if (Regex("""\.(?:mp4|m3u8)(?:$|\?)""", RegexOption.IGNORE_CASE).containsMatchIn(resolvedUrl) ||
            Regex("""/master\.txt(?:$|\?)""", RegexOption.IGNORE_CASE).containsMatchIn(resolvedUrl)
        ) {
            return NativeExtractResult(resolvedUrl, warezPageUrl)
        }

        val fallbackPage = fetchPage(client, cookies, resolvedUrl, warezPageUrl)
        val direct = findDirectMedia(fallbackPage.html, fallbackPage.url)
            ?: throw Exception("mídia não encontrada em ${safeUrl(fallbackPage.url)}")
        return NativeExtractResult(direct, fallbackPage.url, findSubtitleTracks(fallbackPage.html, fallbackPage.url))
    }

    private suspend fun extractWithCookies(
        embedUrl: String,
        initialCookieHeader: String?,
        initialReferer: String? = com.obaflix.BuildConfig.OBAFLIX_URL + "/",
    ): NativeExtractResult {
        val input = try { URL(embedUrl) } catch (_: Exception) { throw Exception("URL SuperFlix inválida") }
        if (!isChainHost(input.host)) throw Exception("URL SuperFlix inválida")

        val client = ObaflixApp.httpClient.newBuilder()
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
        val cookies = CookieStore()
        cookies.seed(embedUrl, initialCookieHeader)

        val warezPage = resolveWarezPage(client, cookies, embedUrl, initialReferer)
        val delegatedProvider = PlayerExtractors.detectProvider(warezPage.url)
        if (delegatedProvider != null && delegatedProvider != "superflix") {
            log("delegate", "provider=$delegatedProvider url=${safeUrl(warezPage.url)}")
            return PlayerExtractors.extractResult(warezPage.url)
        }
        val pageToken = findPageToken(warezPage.html)
            ?: throw Exception("page_token não encontrado na página WarezCDN")
        val payload = decodeTokenPayload(pageToken)
        val host = payload?.optString("embed_context_host")?.takeIf { it.isNotBlank() }
            ?: URL(warezPage.url).query
                ?.split("&")
                ?.firstOrNull { it.startsWith("host=") }
                ?.substringAfter("host=")
                ?.let { URLDecoder.decode(it, "UTF-8") }
            ?: "vizero.buzz"
        val sourceIds = findSourceIds(warezPage.html)
        if (sourceIds.isEmpty()) throw Exception("nenhum video_id encontrado na página WarezCDN")

        log("sources", "total=${sourceIds.size} native=${sourceIds.count { it.startsWith("native_media:") }}")
        val failures = mutableListOf<String>()

        for (sourceId in sourceIds) {
            try {
                val target = postSource(client, cookies, warezPage, pageToken, sourceId, host)
                val result = resolveSource(client, cookies, target, warezPage.url)
                val tipo = if (result.stream.contains(".mp4", ignoreCase = true)) "mp4" else "hls"
                log("ok", "source=${if (sourceId.startsWith("native_media:")) "native" else "embed"} tipo=$tipo host=${safeUrl(result.stream)}")
                return result
            } catch (e: Exception) {
                failures.add("$sourceId: ${e.message}")
                log("source_skip", "source=$sourceId erro=${e.message?.take(100)}")
            }
        }

        throw Exception("todas as fontes SuperFlix falharam: ${failures.joinToString(" | ").take(500)}")
    }

    suspend fun extract(embedUrl: String): NativeExtractResult {
        // Primeiro aproveita uma validação Cloudflare já existente no WebView.
        val cookieManager = CookieManager.getInstance()
        val playerState = ObaflixApp.playerState
        playerState.resetSuperflixObservation()

        try {
            var cookieHeader = runCatching { cookieManager.getCookie(embedUrl) }.getOrNull()

            try {
                return extractWithCookies(embedUrl, cookieHeader)
            } catch (_: CloudflareChallengeException) {
                log("cloudflare", "aguardando validação do WebView")
            }

            // O iframe visível executa a validação e o player original. Além das páginas
            // assinadas, o WebViewClient observa o primeiro manifesto/MP4 real solicitado
            // pelo player. Essa URL pode ser entregue diretamente ao player nativo sem
            // reimplementar o JavaScript protegido do provedor.
            val deadline = System.currentTimeMillis() + 120_000L
            var lastObserved: String? = null
            while (System.currentTimeMillis() < deadline) {
                delay(350L)

                playerState.observedSuperflixMedia?.let { media ->
                    log("media", "capturada kind=${media.kind} url=${safeUrl(media.url)}")
                    return NativeExtractResult(
                        stream = media.url,
                        referer = media.referer ?: embedUrl,
                    )
                }

                val current = runCatching { cookieManager.getCookie(embedUrl) }.getOrNull()
                if (!current.isNullOrBlank()) cookieHeader = current

                val observed = playerState.observedSuperflixUrl
                if (!observed.isNullOrBlank() && observed != lastObserved) {
                    lastObserved = observed
                    try {
                        log("cloudflare", "URL validada observada: ${safeUrl(observed)}")
                        return extractWithCookies(observed, cookieHeader, embedUrl)
                    } catch (error: CloudflareChallengeException) {
                        // O token ainda pode estar sendo finalizado; continua aguardando.
                    } catch (error: Exception) {
                        log("cloudflare_retry", error.message?.take(160) ?: error.javaClass.simpleName)
                    }
                } else if (!current.isNullOrBlank() && current.contains("cf_clearance=")) {
                    try {
                        log("cloudflare", "cf_clearance recebido; retomando extração")
                        return extractWithCookies(embedUrl, cookieHeader)
                    } catch (_: CloudflareChallengeException) { }
                }
            }

            throw Exception("SuperFlix abriu, mas nenhuma mídia foi observada em 2 minutos")
        } finally {
            playerState.finishSuperflixObservation()
        }
    }
}
