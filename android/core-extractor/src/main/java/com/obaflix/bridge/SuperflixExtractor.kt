package com.obaflix.bridge

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
import android.util.Base64


/**
 * O provedor troca de terminação de tempos em tempos: `.pro`, depois `.sbs`, e
 * em campo (01/09/2026) a página redirecionou para `.beer`. As antigas seguem
 * gravadas em URLs no banco e nas respostas do Playerflix, então todas
 * continuam reconhecidas — e o que identifica é o rótulo `superflixapi`, não a
 * terminação, que muda sem aviso.
 */
private val SUPERFLIX_HOSTS = listOf("superflixapi.sbs", "superflixapi.pro", "superflixapi.beer")
private const val SUPERFLIX_TIMEOUT_HOPS = 7

/**
 * Orçamento para inspecionar servidores antes de escolher. Cada fonte custa um
 * POST em player/source mais uma leitura de manifesto; o limite evita que uma
 * página com muitos servidores atrase demais o início da reprodução.
 */
private const val SUPERFLIX_PROBE_BUDGET_MS = 14_000L

/** Master HLS com várias qualidades e legendas — não vale a pena procurar mais. */
private const val SUPERFLIX_EXCELLENT_SCORE = 110

/** Espera depois da primeira mídia observada, para o player pedir as legendas. */
private const val SUPERFLIX_SUBTITLE_GRACE_MS = 1_800L

/**
 * A cadeia direta é caríssima: percorre páginas, bootstrap e player/source. Um
 * intervalo fixo curto virava ~48 tentativas em 2 minutos, o que derruba a sessão
 * e provoca novo desafio. Poucas tentativas com espera crescente, e depois o fluxo
 * apenas aguarda a escolha do usuário.
 */
private const val SUPERFLIX_DIRECT_RETRY_BASE_MS = 3_000L
private const val SUPERFLIX_DIRECT_RETRY_MAX = 3

/** Resultado nativo com Referer opcional para o CDN final. */
data class NativeExtractResult(
    val stream: String,
    val referer: String?,
    val subtitles: List<SubtitleTrack> = emptyList(),
    /** "hls" ou "mp4" quando conhecido; null deixa a decisão para o chamador. */
    val tipo: String? = null,
    val isMaster: Boolean = false,
    val qualities: List<String> = emptyList(),
    val audioTracks: List<String> = emptyList(),
    /** Epoch em milissegundos em que o token da cadeia expira, quando declarado. */
    val expiresAt: Long? = null,
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

    /**
     * O SuperFlix ainda publica algumas URLs absolutas como HTTP, embora o CDN
     * aceite HTTPS. WebView e OkHttp bloqueiam essas URLs por política de
     * cleartext/mixed content, então promovemos somente mídia e legendas para
     * HTTPS em vez de liberar tráfego inseguro para o aplicativo inteiro.
     */
    private fun secureTransportUrl(raw: String): String? = try {
        val parsed = URL(raw)
        when (parsed.protocol.lowercase()) {
            "https" -> parsed.toString()
            "http" -> URL(
                "https",
                parsed.host,
                if (parsed.port == 80) -1 else parsed.port,
                parsed.file,
            ).toString()
            else -> null
        }
    } catch (_: Exception) {
        null
    }

    private fun findSubtitleTracks(html: String, baseUrl: String): List<SubtitleTrack> {
        val normalized = normalizeHtml(html)
        val found = linkedMapOf<String, SubtitleTrack>()
        fun add(raw: String?, label: String? = null) {
            val resolved = resolveUrl(raw, baseUrl) ?: return
            val file = secureTransportUrl(resolved) ?: return
            if (!Regex("""\.(?:vtt|srt|ass|ssa)(?:$|\?)""", RegexOption.IGNORE_CASE).containsMatchIn(file)) return
            // putIfAbsent so existe da API 24; o modulo alcanca a 21.
            if (!found.containsKey(file)) {
                found[file] = SubtitleTrack(file, label?.takeIf { it.isNotBlank() } ?: "Português")
            }
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

    /**
     * Um servidor oferecido para o conteúdo, venha ele de /player/bootstrap
     * (protocolo atual) ou da varredura do HTML (protocolo legado).
     */
    private data class SourceOption(
        val id: String,
        val label: String,
        /** null quando o caminho legado não informa; true = MP4 direto do provedor. */
        val isFile: Boolean?,
        val orderScore: Int,
    ) {
        /**
         * Servidor incorporado em vez de arquivo direto. Cobre `native_media:` e
         * `native_media_v2:` — o prefixo mudou e o teste antigo por `native_media:`
         * passou a classificar todo servidor nativo como alternativo.
         */
        val isEmbedServer: Boolean
            get() = isFile?.not() ?: !id.startsWith("native_media")
    }

    /** Uma fonte já resolvida e medida, pronta para ser comparada com as outras. */
    private data class MediaProfile(
        val option: SourceOption,
        val result: NativeExtractResult,
        val score: Int,
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

    /**
     * As etapas do SuperFlix entram na mesma trilha das fases nativas.
     *
     * Antes saiam sob a tag propria "Obaflix/Superflix", em paralelo ao resto:
     * para saber se o desafio da Cloudflare tinha atrasado a extracao era preciso
     * cruzar dois fluxos de log a mao, comparando horarios.
     */
    private fun log(step: String, detail: String = "") {
        ObaLog.evento(ObaLog.Fase.PROVEDOR, "sf_$step", "detalhe" to detail)
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

    /**
     * O provedor migrou de superflixapi.pro para superflixapi.sbs. O domínio
     * antigo ainda responde com 301 e continua gravado em URLs no banco, então
     * os dois seguem aceitos.
     */
    private fun ehHostSuperflix(host: String): Boolean =
        SUPERFLIX_HOSTS.any { host == it || host.endsWith(".$it") }

    private fun isChainHost(hostname: String): Boolean {
        val host = hostname.lowercase()
        return ehHostSuperflix(host) ||
            host.contains("vizer") || host.contains("warezcdn")
    }

    /**
     * Nomeia o desafio encontrado, para o log dizer se ele se resolve sozinho.
     *
     * - embed_turnstile_interativo: portao proprio do SuperFlix. Exige resolver o
     *   widget Turnstile e submeter o formulario; nenhuma espera passiva resolve.
     * - turnstile: widget Turnstile sem o formulario de embed.
     * - interstitial_cloudflare: "Just a moment"/challenge-running padrao, que
     *   normalmente se resolve sozinho em alguns segundos.
     */
    private fun challengeKind(html: String): String {
        val text = html.lowercase()
        val temFormularioEmbed = text.contains("cf_embed_challenge")
        val temTurnstile = text.contains("turnstilesitekey") || text.contains("cf-turnstile")
        return when {
            temFormularioEmbed && temTurnstile -> "embed_turnstile_interativo"
            temTurnstile -> "turnstile"
            else -> "interstitial_cloudflare"
        }
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
            val candidate = normalizeHtml(raw).trim()
            // Páginas do SuperFlix contêm exemplos/template como `${url}` e
            // `${thumb}`. Eles não são navegação real e acabavam consumindo o
            // limite de hops até o erro "cadeia excedeu o limite".
            if (candidate.contains('$') || candidate.contains('{') || candidate.contains('}')) return
            val absolute = resolveUrl(candidate, baseUrl) ?: return
            val parsed = try { URL(absolute) } catch (_: Exception) { return }
            // Scripts do desafio Cloudflare pertencem ao mesmo host, mas não são
            // páginas da cadeia SuperFlix/Vizero/WarezCDN.
            if (parsed.path.startsWith("/cdn-cgi/", ignoreCase = true)) return
            val isSuperflix = ehHostSuperflix(parsed.host.lowercase())
            if (isSuperflix &&
                parsed.query?.contains("cfv=", ignoreCase = true) != true &&
                !parsed.path.startsWith("/player/", ignoreCase = true)
            ) return
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
            if (parsed.host.contains("vizer")) value += 50
            if (parsed.path.contains("/player/")) value -= 30
            return value
        }

        return found.sortedByDescending(::score)
    }

    private fun decodeTokenPayload(token: String): JSONObject? = try {
        val part = token.substringBefore('.')
        val padded = part + "=".repeat((4 - part.length % 4) % 4)
        // URL_SAFE = mesmo alfabeto do getUrlDecoder() (- e _ no lugar de + e /).
        val decoded = Base64.decode(padded, Base64.URL_SAFE)
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

    /**
     * Heurística de HTML usada apenas para decidir a ORDEM em que os servidores
     * são inspecionados. A escolha final vem de [profileScore], que mede o que
     * cada servidor realmente entregou.
     */
    private fun sourceScore(id: String, context: String): Int {
        val text = context.lowercase()
        // No Android o servidor alternativo costuma entregar HLS/HTTPS e é mais
        // completo. O servidor nativo permanece disponível como fallback.
        var score = if (id.startsWith("native_media:")) 0 else 100
        if (Regex("""dublad|portugu|pt-br""").containsMatchIn(text)) score += 40
        if (Regex("""legend|subtitle|\bleg\b""").containsMatchIn(text)) score -= 10
        if (Regex("""full\s*hd|1080|\bhd\b""").containsMatchIn(text)) score += 5
        return score
    }

    /**
     * Aceita o ID numérico simples, o `native_media:123` antigo e o
     * `native_media_v2:262627:131927:1:1:171230:<md5>` atual. A validação anterior
     * exigia dígitos após o prefixo e descartava todos os servidores nativos novos.
     */
    private val sourceIdPattern = Regex("""^(?:native_media(?:_v\d+)?:[A-Za-z0-9:_-]+|\d+)$""")

    private fun findSourceIds(html: String): List<String> {
        val normalized = normalizeHtml(html)
        val found = linkedMapOf<String, SourceCandidate>()

        fun add(id: String, index: Int) {
            val clean = id.trim()
            if (!sourceIdPattern.matches(clean)) return
            val from = maxOf(0, index - 300)
            val to = minOf(normalized.length, index + 300)
            val score = sourceScore(clean, normalized.substring(from, to))
            val previous = found[clean]
            if (previous == null || score > previous.score) {
                found[clean] = SourceCandidate(clean, score, index)
            }
        }

        Regex("""native_media(?:_v\d+)?:[A-Za-z0-9:_-]+""", RegexOption.IGNORE_CASE).findAll(normalized)
            .forEach { add(it.value, it.range.first) }

        val idFragment = """((?:native_media(?:_v\d+)?:)?[A-Za-z0-9:_-]+)"""
        val patterns = listOf(
            Regex("""(?:video[_-]?id|data-video-id|data-player-id|data-source-id|data-id)\s*[:=]\s*["']?$idFragment""", RegexOption.IGNORE_CASE),
            Regex("""name=["']video_id["'][^>]*value=["']$idFragment["']""", RegexOption.IGNORE_CASE),
            Regex("""value=["']$idFragment["'][^>]*name=["']video_id["']""", RegexOption.IGNORE_CASE),
        )
        for (pattern in patterns) {
            pattern.findAll(normalized).forEach { add(it.groupValues[1], it.range.first) }
        }

        return found.values
            .sortedWith(compareByDescending<SourceCandidate> { it.score }.thenBy { it.index })
            .map { it.id }
    }

    /**
     * `contentid` que /player/bootstrap exige. É um identificador interno do
     * SuperFlix — não é o TMDB nem o `embed_item_id` do token — então só resta
     * procurá-lo na página.
     */
    private fun findContentId(html: String): String? {
        val normalized = normalizeHtml(html)
        val patterns = listOf(
            Regex("""["']?content[_-]?id["']?\s*[:=]\s*["']?(\d{2,12})""", RegexOption.IGNORE_CASE),
            Regex("""name=["']contentid["'][^>]*value=["'](\d{2,12})["']""", RegexOption.IGNORE_CASE),
            Regex("""value=["'](\d{2,12})["'][^>]*name=["']contentid["']""", RegexOption.IGNORE_CASE),
            Regex("""data-content-id=["'](\d{2,12})["']""", RegexOption.IGNORE_CASE),
            Regex("""contentid=(\d{2,12})""", RegexOption.IGNORE_CASE),
        )
        for (pattern in patterns) {
            pattern.find(normalized)?.groupValues?.getOrNull(1)?.takeIf { it.isNotBlank() }?.let { return it }
        }
        return null
    }

    /** Extrai tipo/temporada/episódio de um caminho como /serie/dexter/1/1 ou /filme/xxx. */
    private fun contentCoordinates(path: String): Triple<String, String?, String?> {
        val parts = path.split('/').filter { it.isNotBlank() }
        val tipo = parts.firstOrNull()?.lowercase()?.takeIf { it == "serie" || it == "filme" } ?: "filme"
        if (tipo != "serie") return Triple(tipo, null, null)
        return Triple(tipo, parts.getOrNull(2), parts.getOrNull(3))
    }

    /**
     * Pede a lista de servidores ao protocolo atual. Antes essa lista era raspada
     * do HTML de uma página Vizero/WarezCDN que saiu da cadeia; agora vem em JSON,
     * já com o nome e o tipo de cada servidor.
     */
    private suspend fun fetchBootstrap(
        client: OkHttpClient,
        cookies: CookieStore,
        page: Page,
        pageToken: String,
        contentId: String,
        contentPath: String,
    ): List<SourceOption> {
        val pageUrl = URL(page.url)
        val origin = "${pageUrl.protocol}://${pageUrl.host}"
        val (tipo, season, episode) = contentCoordinates(contentPath)

        val form = FormBody.Builder()
            .add("contentid", contentId)
            .add("type", tipo)
        if (season != null) form.add("season", season)
        if (episode != null) form.add("episode", episode)
        form.add("_token", "")
            .add("page_token", pageToken)
            // O provedor envia o token nas duas grafias; manter as duas evita
            // depender de qual delas o backend lê.
            .add("pageToken", pageToken)

        val result = requestOnce(
            client = client,
            cookies = cookies,
            url = "$origin/player/bootstrap",
            referer = page.url,
            method = "POST",
            body = form.build(),
            accept = "*/*",
            dest = "empty",
            mode = "cors",
            extraHeaders = mapOf(
                "Origin" to origin,
                "X-Requested-With" to "XMLHttpRequest",
            ),
        )
        if (result.status !in 200..299) throw Exception("player/bootstrap HTTP ${result.status}")

        val options = JSONObject(result.body).optJSONObject("data")?.optJSONArray("options")
            ?: throw Exception("player/bootstrap sem options")

        val parsed = mutableListOf<SourceOption>()
        for (index in 0 until options.length()) {
            val option = options.optJSONObject(index) ?: continue
            // ID vem como número nos servidores incorporados e como string nos nativos.
            val id = option.opt("ID")?.toString()?.trim().orEmpty()
            if (id.isEmpty() || id == "null") continue
            val name = option.optString("name").takeIf { it.isNotBlank() } ?: "Servidor $id"
            val isFile = option.optBoolean("is_file", false)
            parsed.add(
                SourceOption(
                    id = id,
                    label = name,
                    isFile = isFile,
                    orderScore = 0,
                ).let { it.copy(orderScore = optionOrderScore(it)) }
            )
        }
        return parsed
    }

    /** Ordem de inspeção — não decide a escolha final, só quem é sondado primeiro. */
    private fun optionOrderScore(option: SourceOption): Int {
        val text = option.label.lowercase()
        var score = if (option.isEmbedServer) 100 else 0
        if (Regex("""dublad|portugu|pt-br""").containsMatchIn(text)) score += 40
        if (Regex("""legend|subtitle|\bleg\b""").containsMatchIn(text)) score -= 10
        if (Regex("""full\s*hd|1080|\bhd\b""").containsMatchIn(text)) score += 5
        return score
    }

    /**
     * Lista de servidores pelo protocolo atual, caindo para a varredura de HTML
     * quando o `contentid` não está na página ou o bootstrap não responde.
     */
    private suspend fun resolveOptions(
        client: OkHttpClient,
        cookies: CookieStore,
        page: Page,
        pageToken: String,
        payload: JSONObject?,
    ): List<SourceOption> {
        val contentId = findContentId(page.html)
        if (contentId != null) {
            val contentPath = payload?.optString("embed_content_path")?.takeIf { it.isNotBlank() }
                ?: runCatching { URL(page.url).path }.getOrDefault("")
            val bootstrap = runCatching {
                fetchBootstrap(client, cookies, page, pageToken, contentId, contentPath)
            }.getOrElse { error ->
                log("bootstrap_skip", error.message?.take(120) ?: error.javaClass.simpleName)
                emptyList()
            }
            if (bootstrap.isNotEmpty()) {
                log("bootstrap", "servidores=" + bootstrap.joinToString(", ") { it.label })
                return bootstrap.sortedByDescending { it.orderScore }
            }
        } else {
            log("bootstrap_skip", "contentid não encontrado na página")
        }

        // Protocolo legado: os IDs vinham no HTML e o rótulo era o texto ao redor.
        return findSourceIds(page.html).mapIndexed { index, id ->
            SourceOption(id = id, label = id, isFile = null, orderScore = -index)
        }
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
            val resolved = resolveUrl(candidate, baseUrl) ?: continue
            secureTransportUrl(resolved)?.let { return it }
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
                // O provedor redireciona para HTTP em parte da cadeia. Como o app
                // roda com cleartext desligado, seguir o Location como veio aborta
                // com "CLEARTEXT communication not permitted" antes de chegar à
                // mídia. Até aqui só a mídia final era promovida a HTTPS.
                val next = resolveUrl(location, url)?.let { secureTransportUrl(it) }
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
        initialReferer: String? = com.obaflix.core.BuildConfig.OBAFLIX_URL + "/",
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
                // Registra QUAL desafio veio. "cf_embed_challenge" + turnstileSiteKey
                // e o portao interativo que o provedor colocou na frente do embed:
                // ele exige que o widget Turnstile seja resolvido e o formulario
                // submetido. Distinguir isso de um "Just a moment" comum importa,
                // porque o segundo se resolve sozinho e o primeiro nao.
                log("cloudflare_desafio", "tipo=${challengeKind(page.html)} url=${safeUrl(page.url)}")
                throw CloudflareChallengeException()
            }

            val delegatedProvider = PlayerExtractors.detectProvider(page.url)
            if (delegatedProvider != null && delegatedProvider != "superflix") return page

            // Protocolo atual: a própria página do SuperFlix traz page_token e
            // contentid, e a lista de servidores vem de /player/bootstrap. Seguir
            // links daqui só levava a becos, já que Vizero/WarezCDN saíram da cadeia.
            if (findPageToken(page.html) != null && findContentId(page.html) != null) return page

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
        // Sem Vizero/WarezCDN na cadeia, host e site vão vazios e o endpoint perde a
        // query. Mandar "vizero.buzz" (o antigo padrão) descrevia um salto que não
        // acontece mais.
        val endpoint = if (host.isBlank()) {
            "$origin/player/source"
        } else {
            "$origin/player/source?host=${java.net.URLEncoder.encode(host, "UTF-8")}"
        }
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
            // Mesmo motivo do fetchPage: o destino do player/redirect pode vir em
            // HTTP e a requisição seguinte morreria por política de cleartext.
            resolveUrl(first.headers["Location"], targetUrl)?.let { secureTransportUrl(it) }
                ?: throw Exception("player/redirect sem Location válido")
        } else {
            if (first.status !in 200..299) throw Exception("player/redirect HTTP ${first.status}")
            targetUrl
        }

        val parsed = URL(resolvedUrl)
        log("target", safeUrl(resolvedUrl))

        if (parsed.path.contains("/player/native/media/")) {
            val mediaPage = fetchPage(client, cookies, resolvedUrl, warezPageUrl)
            val rawMediaSource = findNativeMediaSource(mediaPage.html, mediaPage.url)
                ?: throw Exception("media-source não encontrado no player nativo")
            val mediaSource = secureTransportUrl(rawMediaSource)
                ?: throw Exception("media-source sem transporte HTTPS")
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
                val redirected = resolveUrl(mediaResponse.headers["Location"], mediaSource)
                    ?: throw Exception("media-source sem Location final")
                val finalUrl = secureTransportUrl(redirected)
                    ?: throw Exception("media-source final sem HTTPS")
                return NativeExtractResult(
                    finalUrl,
                    null,
                    subtitles,
                    tipo = if (looksLikeHlsUrl(finalUrl)) "hls" else "mp4",
                )
            }

            val contentType = mediaResponse.headers["Content-Type"].orEmpty()
            if (mediaResponse.status in 200..299 &&
                (contentType.contains("video/mp4", ignoreCase = true) || contentType.contains("octet-stream", ignoreCase = true))
            ) {
                return NativeExtractResult(mediaSource, mediaPage.url, subtitles, tipo = "mp4")
            }
            throw Exception("media-source HTTP ${mediaResponse.status}")
        }

        if (parsed.host.contains("embedplayer") || parsed.host.contains("xn--kcksk7a2bl5le7b6doc1h3f") || parsed.host.contains("xn--tckasiu6cvova0eb5fua2449g98vg") ||
            Regex("""/video/[a-f0-9]{16,}""", RegexOption.IGNORE_CASE).containsMatchIn(parsed.path)
        ) {
            val warez = URL(warezPageUrl)
            val r = "${warez.protocol}://${warez.host}/"
            val subtitles = runCatching {
                val embedPage = fetchPage(client, cookies, resolvedUrl, warezPageUrl)
                findSubtitleTracks(embedPage.html, embedPage.url)
            }.getOrDefault(emptyList())
            val stream = PlayerExtractors.extractEmbedPlayer(resolvedUrl, r)
            return NativeExtractResult(stream, resolvedUrl, subtitles)
        }

        if (Regex("""\.(?:mp4|m3u8)(?:$|\?)""", RegexOption.IGNORE_CASE).containsMatchIn(resolvedUrl) ||
            Regex("""/master\.txt(?:$|\?)""", RegexOption.IGNORE_CASE).containsMatchIn(resolvedUrl)
        ) {
            val stream = secureTransportUrl(resolvedUrl)
                ?: throw Exception("mídia direta sem transporte HTTPS")
            return NativeExtractResult(
                stream,
                warezPageUrl,
                tipo = if (looksLikeMp4Url(stream)) "mp4" else "hls",
            )
        }

        val fallbackPage = fetchPage(client, cookies, resolvedUrl, warezPageUrl)
        val direct = findDirectMedia(fallbackPage.html, fallbackPage.url)
            ?: throw Exception("mídia não encontrada em ${safeUrl(fallbackPage.url)}")
        return NativeExtractResult(
            direct,
            fallbackPage.url,
            findSubtitleTracks(fallbackPage.html, fallbackPage.url),
            tipo = if (looksLikeMp4Url(direct)) "mp4" else null,
        )
    }

    private fun looksLikeHlsUrl(url: String): Boolean =
        Regex("""\.m3u8(?:$|\?)""", RegexOption.IGNORE_CASE).containsMatchIn(url) ||
            Regex("""/master\.txt(?:$|\?)""", RegexOption.IGNORE_CASE).containsMatchIn(url) ||
            url.contains("/cdn/hls/", ignoreCase = true)

    private fun looksLikeMp4Url(url: String): Boolean =
        Regex("""\.mp4(?:$|\?)""", RegexOption.IGNORE_CASE).containsMatchIn(url)

    /**
     * Nota de qualidade real da fonte. Um master HLS vale mais que um HLS simples,
     * que vale mais que um MP4 — porque só o master carrega várias qualidades,
     * faixas de áudio e legendas para o JW Player montar os menus.
     */
    private fun profileScore(
        tipo: String,
        info: HlsMediaInfo?,
        hasSubtitles: Boolean,
        option: SourceOption,
    ): Int {
        var score = when {
            info != null && info.isMaster -> 70 + minOf(info.variants.size, 5) * 6
            tipo == "hls" -> 45
            else -> 20
        }
        if ((info?.audioTracks?.size ?: 0) >= 2) score += 35
        if (hasSubtitles) score += 25
        // Desempate: historicamente o servidor alternativo é o mais estável.
        if (option.isEmbedServer) score += 3
        return score
    }

    /**
     * Descobre o que a fonte entrega sem baixar mídia à toa.
     *
     * Quando a URL não denuncia o formato, um Range de 1 byte revela o
     * Content-Type; o corpo só é lido quando o alvo é mesmo um manifesto.
     */
    private suspend fun profileSource(
        client: OkHttpClient,
        cookies: CookieStore,
        option: SourceOption,
        candidate: NativeExtractResult,
    ): MediaProfile {
        val url = candidate.stream
        var tipo = candidate.tipo
            ?: when {
                looksLikeHlsUrl(url) -> "hls"
                looksLikeMp4Url(url) -> "mp4"
                else -> null
            }

        // O corpo só é lido quando há indício positivo de manifesto. Sem essa trava,
        // uma URL sem extensão classificada como HLS por padrão faria o extrator
        // baixar o filme inteiro para a memória.
        var readsManifest = tipo == "hls"

        if (tipo == null) {
            val head = runCatching {
                requestOnce(
                    client = client,
                    cookies = cookies,
                    url = url,
                    referer = candidate.referer,
                    accept = "*/*",
                    dest = "video",
                    mode = "no-cors",
                    extraHeaders = mapOf("Range" to "bytes=0-0"),
                    readBody = false,
                )
            }.getOrNull()
            val contentType = head?.headers?.get("Content-Type").orEmpty().lowercase()
            when {
                contentType.contains("mpegurl") || contentType.contains("m3u") -> {
                    tipo = "hls"
                    readsManifest = true
                }
                contentType.contains("mp4") || contentType.contains("octet-stream") -> tipo = "mp4"
                // Formato indefinido: mantém o padrão histórico do bridge ("hls"),
                // mas sem tentar interpretar o corpo.
                else -> tipo = "hls"
            }
        }

        var info: HlsMediaInfo? = null
        if (readsManifest) {
            val manifest = runCatching {
                requestOnce(
                    client = client,
                    cookies = cookies,
                    url = url,
                    referer = candidate.referer,
                    accept = "*/*",
                    dest = "empty",
                    mode = "cors",
                )
            }.getOrNull()
            if (manifest != null && manifest.status in 200..299 &&
                HlsManifest.looksLikeManifest(manifest.body)
            ) {
                info = HlsManifest.parse(manifest.body, url)
            }
        }

        val subtitles = linkedMapOf<String, SubtitleTrack>()
        candidate.subtitles.forEach { if (!subtitles.containsKey(it.file)) subtitles[it.file] = it }
        // As legendas declaradas no master costumam apontar para uma sub-playlist
        // .m3u8, que o próprio hls.js resolve. Só um arquivo VTT/SRT direto pode
        // virar `track` do JW Player; o resto apenas conta como capacidade da fonte.
        info?.subtitles?.forEach { track ->
            if (!Regex("""\.(?:vtt|srt)(?:$|\?)""", RegexOption.IGNORE_CASE).containsMatchIn(track.file)) return@forEach
            secureTransportUrl(track.file)?.let { file ->
                if (!subtitles.containsKey(file)) subtitles[file] = track.copy(file = file)
            }
        }

        val hasSubtitles = subtitles.isNotEmpty() || info?.subtitles?.isNotEmpty() == true
        val score = profileScore(tipo, info, hasSubtitles, option)
        log(
            "profile",
            "source=${option.label} tipo=$tipo master=${info?.isMaster == true} " +
                "qualidades=${info?.variants?.size ?: 0} audios=${info?.audioTracks?.size ?: 0} " +
                "legendas=${subtitles.size} noManifesto=${info?.subtitles?.size ?: 0} nota=$score",
        )

        return MediaProfile(
            option = option,
            score = score,
            result = candidate.copy(
                subtitles = subtitles.values.toList(),
                tipo = tipo,
                isMaster = info?.isMaster == true,
                qualities = info?.variants?.map { it.label }.orEmpty(),
                audioTracks = info?.audioTracks.orEmpty(),
            ),
        )
    }

    /** `exp` do token da cadeia, normalizado para epoch em milissegundos. */
    private fun tokenExpiry(payload: JSONObject?): Long? {
        val exp = payload?.optLong("exp", 0L)?.takeIf { it > 0L } ?: return null
        return if (exp < 100_000_000_000L) exp * 1000L else exp
    }

    private suspend fun extractWithCookies(
        embedUrl: String,
        initialCookieHeader: String?,
        initialReferer: String? = com.obaflix.core.BuildConfig.OBAFLIX_URL + "/",
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
            ?: ""
        val sourceOptions = resolveOptions(client, cookies, warezPage, pageToken, payload)
        if (sourceOptions.isEmpty()) throw Exception("nenhum servidor encontrado para o conteúdo")

        log(
            "sources",
            "total=${sourceOptions.size} nativos=${sourceOptions.count { !it.isEmbedServer }}",
        )
        val failures = mutableListOf<String>()
        val profiles = mutableListOf<MediaProfile>()
        val expiresAt = tokenExpiry(payload)
        val probeDeadline = System.currentTimeMillis() + SUPERFLIX_PROBE_BUDGET_MS

        // Inspeciona os servidores em vez de aceitar o primeiro que responde: o
        // primeiro funcional costuma ser um MP4 de qualidade única, enquanto outro
        // servidor entrega um master HLS com qualidades, áudio e legendas.
        for (option in sourceOptions) {
            try {
                val target = postSource(client, cookies, warezPage, pageToken, option.id, host)
                val candidate = resolveSource(client, cookies, target, warezPage.url)
                val profile = profileSource(client, cookies, option, candidate)
                profiles.add(profile)
                if (profile.score >= SUPERFLIX_EXCELLENT_SCORE) {
                    log("probe_stop", "fonte completa encontrada em ${option.label}")
                    break
                }
            } catch (e: Exception) {
                failures.add("${option.label}: ${e.message}")
                log("source_skip", "source=${option.label} erro=${e.message?.take(100)}")
            }
            if (System.currentTimeMillis() > probeDeadline && profiles.isNotEmpty()) {
                log("probe_stop", "orçamento de inspeção esgotado com ${profiles.size} fonte(s)")
                break
            }
        }

        val best = profiles.maxByOrNull { it.score }
            ?: throw Exception("todas as fontes SuperFlix falharam: ${failures.joinToString(" | ").take(500)}")

        log(
            "ok",
            "escolhida=${best.option.label} nota=${best.score} entre=${profiles.size} " +
                "tipo=${best.result.tipo} host=${safeUrl(best.result.stream)}",
        )
        return best.result.copy(expiresAt = expiresAt)
    }

    /**
     * Depois da primeira mídia, o player ainda pede as legendas. Retornar na hora
     * descartava esse pedido e o episódio abria sem faixa em português. A espera
     * também permite trocar um MP4 recém-visto por um manifesto HLS que apareça
     * logo em seguida.
     */
    private suspend fun awaitObservedMedia(
        playerState: PlayerState,
        embedUrl: String,
        first: ObservedSuperflixMedia,
    ): NativeExtractResult {
        val deadline = System.currentTimeMillis() + SUPERFLIX_SUBTITLE_GRACE_MS
        var media = first
        while (System.currentTimeMillis() < deadline) {
            delay(150L)
            playerState.observedSuperflixMedia?.let { media = it }
            if (media.kind == "hls" && playerState.observedSuperflixSubtitles.isNotEmpty()) break
        }

        val subtitles = playerState.observedSuperflixSubtitles.mapNotNull { observed ->
            secureTransportUrl(observed.url)?.let { SubtitleTrack(it) }
        }
        log(
            "media",
            "consolidada kind=${media.kind} legendas=${subtitles.size} url=${safeUrl(media.url)}",
        )
        return NativeExtractResult(
            stream = media.url,
            referer = media.referer ?: embedUrl,
            subtitles = subtitles,
            tipo = media.kind,
        )
    }

    /**
     * A midia observada responde de verdade?
     *
     * Um GET com o mesmo contexto da WebView — UA do sistema, cookies do
     * CookieManager, Referer capturado. Custa uma requisicao e evita entregar
     * ao player uma URL que ja nasce recusada: em campo, a candidata que a
     * pagina pedia sozinha devolvia 403 e o player repetia o 403 quatro vezes
     * antes de o failover andar.
     *
     * Erro de rede nao condena: so status 4xx do proprio CDN. Sem resposta, a
     * duvida fica para o player resolver, que e quem de fato reproduz.
     */
    private suspend fun midiaAceita(media: ObservedSuperflixMedia): Boolean =
        withContext(Dispatchers.IO) {
            runCatching {
                val requisicao = Request.Builder()
                    .url(media.url)
                    .get()
                    .header("User-Agent", SuperflixChallengeOverlay.uaEmUso ?: UA)
                    .apply {
                        media.referer?.takeIf { it.isNotBlank() }?.let { header("Referer", it) }
                        runCatching { CookieManager.getInstance().getCookie(media.url) }
                            .getOrNull()?.takeIf { it.isNotBlank() }?.let { header("Cookie", it) }
                    }
                    .build()
                ObaflixApp.httpClient.newCall(requisicao).execute().use { r ->
                    log("media_conferida", "status=${r.code} url=${safeUrl(media.url)}")
                    r.code !in 400..499
                }
            }.getOrElse { true }
        }

    suspend fun extract(embedUrl: String): NativeExtractResult {
        // Primeiro aproveita uma validação Cloudflare já existente no WebView.
        val cookieManager = CookieManager.getInstance()
        val playerState = ObaflixApp.playerState
        val observation = playerState.beginSuperflixObservation()

        try {
            var cookieHeader = runCatching { cookieManager.getCookie(embedUrl) }.getOrNull()

            try {
                val direto = extractWithCookies(embedUrl, cookieHeader)
                log("direto", "resolvido sem interação do usuário")
                return direto
            } catch (_: CloudflareChallengeException) {
                log("cloudflare", "aguardando validação do WebView")
                // O portao do SuperFlix e interativo: so uma pessoa resolve. Em vez
                // de esperar em silencio por algo que nunca chega sozinho, mostra a
                // pagina do provedor para o usuario, como o Electron ja faz.
                ObaflixApp.hostWebView?.get()?.let { host ->
                    log("overlay", "abrindo desafio interativo para o usuario")
                    SuperflixChallengeOverlay.abrir(host, embedUrl)
                } ?: log("overlay", "WebView principal indisponivel; seguindo sem overlay")
            } catch (error: Exception) {
                // Falhar aqui não pode encerrar a extração. O WebView ainda vai
                // abrir a sessão, e a tentativa direta se repete adiante com o
                // cookie válido. Antes, qualquer erro que não fosse Cloudflare
                // abortava tudo e sobrava só a escolha manual de servidor.
                log("direto_falhou", error.message?.take(160) ?: error.javaClass.simpleName)
            }

            // O iframe visível executa a validação e o player original. Além das páginas
            // assinadas, o WebViewClient observa o primeiro manifesto/MP4 real solicitado
            // pelo player. Essa URL pode ser entregue diretamente ao player nativo sem
            // reimplementar o JavaScript protegido do provedor.
            val inicioEspera = System.currentTimeMillis()
            // Deadline movel: enquanto o overlay estiver aberto o usuario esta
            // resolvendo o Turnstile e escolhendo servidor, e o relogio nao pode
            // correr contra ele. O contador so volta a valer quando o overlay
            // fecha — e a promise do extractStream fica pendente ate la, entao o
            // CustomPlayer nao avanca para a proxima fonte no meio da interacao.
            var deadline = inicioEspera + 120_000L
            var lastObserved: String? = null
            var proximaTentativaDireta = 0L
            var tentativasDiretas = 0
            var proximoRelatorio = inicioEspera + 10_000L
            var viuClearance = false
            var overlayEsteveAberto = false
            while (System.currentTimeMillis() < deadline) {
                delay(350L)

                if (SuperflixChallengeOverlay.estaAberto) {
                    // Empurra o prazo enquanto a interacao acontece.
                    overlayEsteveAberto = true
                    deadline = System.currentTimeMillis() + 120_000L
                }

                // Sem isto a espera ficava totalmente muda: o log mostrava
                // "aguardando validacao" e nada mais ate o fallback cancelar, sem
                // dizer se o cookie chegou, se alguma midia foi vista ou se
                // simplesmente nada aconteceu.
                if (System.currentTimeMillis() >= proximoRelatorio) {
                    proximoRelatorio += 10_000L
                    val segundos = (System.currentTimeMillis() - inicioEspera) / 1000
                    log(
                        "cloudflare_espera",
                        "${segundos}s — cf_clearance=${if (viuClearance) "sim" else "nao"} " +
                            "midia_observada=nao url_validada=${if (lastObserved != null) "sim" else "nao"}",
                    )
                }

                playerState.observedSuperflixMedia?.let { media ->
                    // Capturar nao e o mesmo que servir. A pagina tem mais de um
                    // player, e o que arranca sozinho pede um manifesto que o
                    // CDN recusa — medido em campo: 403 tanto pelo contexto da
                    // WebView quanto pelo do player. Entregar essa URL ao player
                    // nativo so adiava o mesmo 403 e queimava a fonte.
                    if (!midiaAceita(media)) {
                        log("media_recusada", "kind=${media.kind} url=${safeUrl(media.url)}")
                        playerState.rejeitarSuperflixMedia(media.url)
                        return@let
                    }
                    log("media", "capturada kind=${media.kind} url=${safeUrl(media.url)}")
                    return awaitObservedMedia(playerState, embedUrl, media)
                }

                // Usuario fechou o overlay sem que midia aparecesse: desistiu do
                // SuperFlix. Sai agora para o fallback tentar o proximo player, em
                // vez de segurar a promise por mais dois minutos a toa.
                if (overlayEsteveAberto && !SuperflixChallengeOverlay.estaAberto) {
                    throw Exception(
                        "SuperFlix: verificacao fechada antes de escolher um servidor",
                    )
                }

                val current = runCatching { cookieManager.getCookie(embedUrl) }.getOrNull()
                if (!current.isNullOrBlank()) cookieHeader = current
                if (current?.contains("cf_clearance=") == true && !viuClearance) {
                    viuClearance = true
                    log("cloudflare", "cf_clearance apareceu no CookieManager")
                    // Grava no disco agora: sem o flush o cookie morre junto com o
                    // processo e o desafio voltaria a cada episodio.
                    SuperflixChallengeOverlay.persistirCookies()
                }

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
                } else if (!current.isNullOrBlank() && current.contains("cf_clearance=") &&
                    tentativasDiretas < SUPERFLIX_DIRECT_RETRY_MAX &&
                    System.currentTimeMillis() >= proximaTentativaDireta
                ) {
                    // Com o desafio resolvido a cadeia completa pode funcionar sem o
                    // usuário escolher servidor. Se não funcionar em poucas tentativas,
                    // para de insistir e deixa a escolha manual seguir — insistir só
                    // castigava a sessão que a escolha manual ainda vai usar.
                    tentativasDiretas += 1
                    proximaTentativaDireta = System.currentTimeMillis() +
                        SUPERFLIX_DIRECT_RETRY_BASE_MS * (1L shl (tentativasDiretas - 1))
                    try {
                        log("cloudflare", "cf_clearance recebido; retomando extração")
                        val direto = extractWithCookies(embedUrl, cookieHeader)
                        log("direto", "resolvido após o desafio, sem escolha manual")
                        return direto
                    } catch (_: CloudflareChallengeException) {
                    } catch (error: Exception) {
                        log("direto_falhou", error.message?.take(160) ?: error.javaClass.simpleName)
                    }
                }
            }

            // Mensagem diz a CONDICAO que produziu o resultado, nao so "indisponivel".
            throw Exception(
                if (!viuClearance) {
                    "SuperFlix: desafio Turnstile do embed nao foi validado em 2 minutos " +
                        "(cf_clearance nunca chegou) — o provedor exige resolver a verificacao"
                } else {
                    "SuperFlix: desafio validado (cf_clearance presente), mas nenhuma midia " +
                        "foi observada em 2 minutos"
                }
            )
        } finally {
            // Fecha em qualquer saida — sucesso, timeout ou cancelamento por troca
            // de episodio —, senao o overlay ficaria cobrindo o app.
            SuperflixChallengeOverlay.fechar()
            playerState.finishSuperflixObservation(observation)
        }
    }
}
