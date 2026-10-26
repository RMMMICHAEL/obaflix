package com.obaflix.bridge

import com.obaflix.core.BuildConfig
import com.obaflix.ObaflixApp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.URL
import java.net.URLEncoder
import android.util.Base64

// ── Extração nativa multi-provider (Android WebView) ───────────────────────────
// Porta em Kotlin da mesma lógica de src/app/api/player/extract/route.ts e de
// desktop/electron/extractors.js — PlayHide, LuluVid, Rola2, Wish, Bolt e Big também
// rodam com o IP residencial do usuário, sem proxy de segmentos pela Vercel.
// Ver docs/player-native-extraction.md para o mapa completo de providers.

private const val UA_NATIVE =
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/122.0.0.0 Mobile Safari/537.36 ObaflixApp/1.0"
private const val MOON_URL = "https://app.megafrixapi.com/moon.php"
private const val REFERER_DEFAULT = "https://megaflix.lat/"

object PlayerExtractors {

    internal class ProviderHttpException(val status: Int) : Exception("provider HTTP $status")

    /**
     * User-Agent que a extracao usa nas requisicoes aos provedores.
     *
     * Publico porque quem reproduz precisa repetir o mesmo par
     * User-Agent/Referer: ha CDN que amarra o link ao par com que ele foi
     * gerado, e um dos dois diferente vira 403 no meio do video, sem erro
     * visivel. No site quem repete e o proxy da Vercel; no Electron, o
     * onBeforeSendHeaders; no movel, a WebView; na TV, o ExoPlayer.
     */
    const val UA_EXTRACAO: String = UA_NATIVE

    // ── HTTP helpers ─────────────────────────────────────────────────────────

    suspend fun fetchHtml(url: String, referer: String = REFERER_DEFAULT): String =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(url)
                .addHeader("User-Agent", UA_NATIVE)
                .addHeader("Accept", "text/html,*/*;q=0.8")
                .addHeader("Accept-Language", "pt-BR,pt;q=0.5")
                .addHeader("Referer", referer)
                .addHeader("Sec-Fetch-Dest", "iframe")
                .addHeader("Sec-Fetch-Mode", "navigate")
                .addHeader("Sec-Fetch-Site", "cross-site")
                .build()
            val comeco = System.currentTimeMillis()
            val response = ObaflixApp.httpClient.newCall(request).execute()
            val ms = System.currentTimeMillis() - comeco
            if (!response.isSuccessful) {
                ObaLog.alerta(
                    ObaLog.Fase.PROVEDOR, "html_nao_2xx",
                    "status" to response.code, "url" to ObaLog.url(url), "ms" to ms,
                )
                throw Exception("HTTP ${response.code} em $url")
            }
            val corpo = response.body?.string() ?: throw Exception("resposta vazia de $url")
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "html_recebido",
                "url" to ObaLog.url(url), "bytes" to corpo.length, "ms" to ms,
            )
            corpo
        }

    private suspend fun moon(obfuscatedScript: String): String = withContext(Dispatchers.IO) {
        // NO_WRAP = alfabeto padrao, com padding e sem quebra de linha —
        // exatamente o que getEncoder() produzia.
        val encoded = Base64.encodeToString(obfuscatedScript.toByteArray(), Base64.NO_WRAP)
        val body = "data=${URLEncoder.encode(encoded, "UTF-8")}"
            .toRequestBody("application/x-www-form-urlencoded".toMediaType())
        val request = Request.Builder()
            .url(MOON_URL)
            .post(body)
            .addHeader("User-Agent", UA_NATIVE)
            .addHeader("Origin", "https://megaflix.lat")
            .addHeader("Referer", REFERER_DEFAULT)
            .build()
        val response = ObaflixApp.httpClient.newCall(request).execute()
        val text = response.body?.string() ?: ""
        if (!response.isSuccessful) throw Exception("moon.php HTTP ${response.code}")
        text
    }

    private suspend fun postPlayer(url: String, id: String): String? = withContext(Dispatchers.IO) {
        val body = FormBody.Builder().add("hash", id).add("r", "").build()
        val request = Request.Builder()
            .url("$url?data=$id&do=getVideo")
            .post(body)
            .addHeader("User-Agent", UA_NATIVE)
            .addHeader("Referer", url)
            .build()
        val response = ObaflixApp.httpClient.newCall(request).execute()
        val text = response.body?.string() ?: return@withContext null
        if (!text.trimStart().startsWith("{")) return@withContext null
        val json = JSONObject(text)
        json.optString("videoSource").takeIf { it.isNotEmpty() }
            ?: json.optString("src").takeIf { it.isNotEmpty() }
    }

    // ── Packer (Dean Edwards) ────────────────────────────────────────────────

    private val PACKER_SQ = Regex(
        """\('((?:[^'\\]|\\[\s\S])*)'\s*,\s*(\d+)\s*,\s*\d+\s*,\s*'((?:[^'\\]|\\[\s\S])*)'\s*\.split\('\|'\)"""
    )
    private val PACKER_DQ = Regex(
        """\("((?:[^"\\]|\\[\s\S])*)"\s*,\s*(\d+)\s*,\s*\d+\s*,\s*"((?:[^"\\]|\\[\s\S])*)"\s*\.split\("\|"\)"""
    )

    // Decode direto de string — equivalente a directDecodePacker() em extractors.js.
    // Cobre o formato padrão eval(function(p,a,c,k,e,d){...}('packed', base, n, 'w1|w2'.split('|')))
    fun directDecodePacker(script: String): String? {
        val m = PACKER_SQ.find(script) ?: PACKER_DQ.find(script) ?: return null
        val packed = m.groupValues[1].replace("\\'", "'").replace("\\\"", "\"").replace("\\\\", "\\")
        val base = m.groupValues[2].toIntOrNull() ?: return null
        val words = m.groupValues[3].split("|")
        if (base < 2 || base > 36 || words.isEmpty()) return null

        return Regex("""\b\w+\b""").replace(packed) { match ->
            val i = match.value.toIntOrNull(base)
            if (i != null && i >= 0 && i < words.size && words[i].isNotEmpty()) words[i] else match.value
        }
    }

    fun extractEvalScript(html: String): String? {
        val idx = html.indexOf("eval(function(p,a,c,k,e,d)")
        if (idx == -1) return null
        val chunk = html.substring(idx, minOf(idx + 50000, html.length))
        val endMatch = Regex("""\.split\('\|'\)\s*,\s*0\s*,\s*\{\s*\}\s*\)\s*\)""").find(chunk)
        if (endMatch != null) return chunk.substring(0, endMatch.range.last + 1)
        val scriptEnd = chunk.indexOf("</script>")
        if (scriptEnd != -1) return chunk.substring(0, scriptEnd)
        return chunk
    }

    fun findM3u8(text: String): String? {
        val patterns = listOf(
            Regex("""["'](https?://[^"']+\.m3u8[^"']*)"""),
            Regex("""file:\s*["'](https?://[^"']+)"""),
            Regex("""source:\s*["'](https?://[^"']+)"""),
        )
        for (re in patterns) {
            val m = re.find(text)
            if (m != null && m.groupValues[1].startsWith("http")) return m.groupValues[1]
        }
        return null
    }

    fun parseDecodedHide(decoded: String, embedUrl: String): String? {
        val linksSplit = decoded.split("var links=").getOrNull(1)
        if (linksSplit != null) {
            try {
                val linksJson = linksSplit.split(";")[0].trim()
                val links = JSONObject(linksJson)
                val src = links.optString("hls3").takeIf { it.isNotEmpty() }
                    ?: links.optString("hls2").takeIf { it.isNotEmpty() }
                    ?: links.optString("hls4").takeIf { it.isNotEmpty() }
                if (src != null) return if (src.startsWith("http")) src else URL(embedUrl).let { "${it.protocol}://${it.host}$src" }
            } catch (_: Exception) { /* tenta próximo método */ }
        }
        val linksMatch = Regex("""var\s+links\s*=\s*(\{[^;]+\})""").find(decoded)
        if (linksMatch != null) {
            try {
                val links = JSONObject(linksMatch.groupValues[1])
                val src = links.optString("hls3").takeIf { it.isNotEmpty() }
                    ?: links.optString("hls2").takeIf { it.isNotEmpty() }
                    ?: links.optString("hls4").takeIf { it.isNotEmpty() }
                if (src != null) return if (src.startsWith("http")) src else URL(embedUrl).let { "${it.protocol}://${it.host}$src" }
            } catch (_: Exception) { /* cai no fallback m3u8 */ }
        }
        return findM3u8(decoded)
    }

    // ── Extratores por provider ───────────────────────────────────────────────

    suspend fun extractVoltz(embedUrl: String): String {
        fun parse(html: String): String? {
            val declared = Regex("""const\s+stream\s*=\s*["']([^"']+)["']""")
                .find(html)?.groupValues?.getOrNull(1)
            if (declared != null) {
                val normalized = declared.replaceFirst(Regex("^httpss://", RegexOption.IGNORE_CASE), "https://")
                if (normalized.startsWith("http")) return normalized
            }
            findM3u8(html)?.let { return it }
            return Regex(
                """https?://[^\s<>"']+\.(?:mp4|m3u8)[^\s<>"']*""",
                RegexOption.IGNORE_CASE
            ).find(html)?.value
        }

        suspend fun validate(candidate: String): String = withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(candidate)
                .addHeader("User-Agent", UA_NATIVE)
                .addHeader("Referer", embedUrl)
                .addHeader("Range", "bytes=0-0")
                .build()
            ObaflixApp.httpClient.newCall(request).execute().use { response ->
                if (response.code == 404 || response.code == 410) {
                    throw Exception("mídia indisponível no Player 3 (HTTP ${response.code})")
                }
            }
            candidate
        }

        parse(fetchHtml(embedUrl, REFERER_DEFAULT))?.let { return validate(it) }
        kotlinx.coroutines.delay(1200)
        val candidate = parse(fetchHtml(embedUrl, REFERER_DEFAULT))
            ?: throw Exception("stream não encontrado no Player 3")
        return validate(candidate)
    }
    suspend fun extractEmbedPlayer(
        embedUrl: String,
        rUrl: String = BuildConfig.OBAFLIX_URL + "/",
        userAgent: String = UA_NATIVE,
        cookieHeader: String? = null,
    ): String {
        val parsed = URL(embedUrl)
        val base = "${parsed.protocol}://${parsed.host}"
        val id = parsed.path.split("/").last { it.isNotEmpty() }
        if (id.isEmpty()) throw Exception("ID não encontrado")

        // "r" preserva o comportamento original (pré-generalização): domínio do próprio app,
        // não megaflix.lat — diferente do Referer/Origin desta mesma requisição.
        val body = FormBody.Builder().add("hash", id).add("r", rUrl).build()
        val request = Request.Builder()
            .url("$base/player/index.php?data=$id&do=getVideo")
            .post(body)
            .addHeader("User-Agent", userAgent)
            .addHeader("X-Requested-With", "XMLHttpRequest")
            .addHeader("Referer", embedUrl)
            .addHeader("Origin", base)
            .apply { cookieHeader?.takeIf { it.isNotBlank() }?.let { addHeader("Cookie", it) } }
            .build()
        val response = withContext(Dispatchers.IO) { ObaflixApp.httpClient.newCall(request).execute() }
        val text = response.body?.string() ?: throw Exception("resposta vazia")
        if (response.code == 403 || response.code == 419) throw ProviderHttpException(response.code)
        if (!response.isSuccessful) throw Exception("EmbedPlayer HTTP ${response.code}")
        if (!text.trimStart().startsWith("{")) throw Exception("Resposta inválida do player")
        val json = JSONObject(text)
        return json.optString("securedLink").takeIf { it.isNotEmpty() }
            ?: json.optString("videoSource").takeIf { it.isNotEmpty() }
            ?: json.optString("src").takeIf { it.isNotEmpty() }
            ?: throw Exception("securedLink não encontrado")
    }

    private fun decodePlayerflixEmbed(value: String): String? {
        val candidate = value.trim()
        if (candidate.isEmpty()) return null

        fun validUrl(raw: String): String? = runCatching {
            val parsed = URL(raw.trim())
            if (parsed.protocol == "https" || parsed.protocol == "http") parsed.toString() else null
        }.getOrNull()

        validUrl(candidate)?.let { return it }
        return runCatching {
            String(Base64.decode(candidate, Base64.DEFAULT), Charsets.UTF_8)
        }.getOrNull()?.let(::validUrl)
    }

    private fun parsePlayerflixEmbeds(body: String): List<String> {
        val result = linkedSetOf<String>()
        runCatching {
            val options = JSONObject(body)
                .optJSONObject("data")
                ?.optJSONArray("options")
            if (options != null) {
                for (index in 0 until options.length()) {
                    val embed = options.optJSONObject(index)?.optString("embed").orEmpty()
                    decodePlayerflixEmbed(embed)?.let(result::add)
                }
            }
        }

        Regex("""data-embed=["']([^"']+)["']""", RegexOption.IGNORE_CASE)
            .findAll(body)
            .forEach { match -> decodePlayerflixEmbed(match.groupValues[1])?.let(result::add) }

        return result.toList()
    }

    suspend fun extractPlayerflix(ajaxUrl: String): NativeExtractResult = withContext(Dispatchers.IO) {
        val input = URL(ajaxUrl)
        val query = input.query.orEmpty()
            .split("&")
            .mapNotNull { part ->
                val key = part.substringBefore("=", "")
                val value = part.substringAfter("=", "")
                if (key.isEmpty()) null else key to java.net.URLDecoder.decode(value, "UTF-8")
            }
            .toMap()
        val type = query["type"]?.takeIf { it == "movie" } ?: "tv"
        val id = query["id"].orEmpty()
        val season = query["season"] ?: "1"
        val episode = query["episode"] ?: "1"
        if (id.isEmpty()) throw Exception("ID PlayerFlix não encontrado")

        val referer = if (type == "tv") {
            "https://playerflix.ink/serie/$id/$season/$episode"
        } else {
            "https://playerflix.ink/filme/$id"
        }
        val request = Request.Builder()
            .url(ajaxUrl)
            .get()
            .addHeader("User-Agent", UA_NATIVE)
            .addHeader("Accept", "application/json, text/plain, */*")
            .addHeader("Accept-Language", "pt-BR,pt;q=0.5")
            .addHeader("Referer", referer)
            .addHeader("X-Requested-With", "XMLHttpRequest")
            .addHeader("Sec-Fetch-Dest", "empty")
            .addHeader("Sec-Fetch-Mode", "cors")
            .addHeader("Sec-Fetch-Site", "same-origin")
            .build()
        val response = ObaflixApp.httpClient.newCall(request).execute()
        val body = response.body?.string().orEmpty()
        if (!response.isSuccessful) throw Exception("PlayerFlix HTTP ${response.code}")

        val embeds = parsePlayerflixEmbeds(body)
        // A API atual do PlayerFlix fornece WatchPlayer como opção principal. O CDN
        // *.hclod.qzz.io valida o Referer do WatchPlayer e devolve 403 quando recebe o
        // Referer do EmbedPlayer legado. Por isso a ordem precisa ser a mesma do extrator web.
        val watchPlayer = embeds.firstOrNull { candidate ->
            runCatching { URL(candidate).host == "v1.watchplay.shop" }.getOrDefault(false)
        }
        val failures = mutableListOf<String>()
        if (watchPlayer != null) {
            try {
                return@withContext NativeExtractResult(
                    stream = extractWatchplayer(watchPlayer),
                    referer = watchPlayer,
                )
            } catch (error: Exception) {
                failures.add("WatchPlayer: ${error.message}")
            }
        }

        val embedPlayer = embeds.firstOrNull { candidate ->
            runCatching { URL(candidate).host.endsWith("embedplayer2.xyz") }.getOrDefault(false)
        } ?: embeds.firstOrNull { candidate ->
            runCatching { URL(candidate).host.contains("embedplayer") }.getOrDefault(false)
        }

        if (embedPlayer != null) {
            try {
                return@withContext NativeExtractResult(
                    stream = extractEmbedPlayer(embedPlayer, ""),
                    referer = embedPlayer,
                )
            } catch (error: Exception) {
                failures.add("EmbedPlayer: ${error.message}")
            }
        }

        throw Exception(
            if (failures.isEmpty()) "servidor compatível não encontrado no PlayerFlix"
            else "PlayerFlix falhou: ${failures.joinToString(" | ").take(300)}"
        )
    }

    /**
     * Espelhos do Hide, na ordem de preferência.
     *
     * playhide.shop era o host canônico e hoje está morto: o HTTPS não completa
     * em versão nenhuma do protocolo, com ou sem SNI. Tentá-lo primeiro custava
     * um timeout inteiro antes de cada reprodução, então foi para o fim da lista
     * — segue ali caso volte. Os espelhos negociam TLS 1.2 e 1.3 normalmente,
     * atendendo Android antigo e atual.
     *
     * Medido em 24/08/2026: playhide.shop sem resposta; hidehide.shop e
     * vidhidehub.com respondem 200 tanto em /v/{id} quanto em /embed/{id}.
     */
    private val HIDE_HOSTS = listOf("hidehide.shop", "vidhidehub.com", "playhide.shop")

    /**
     * Confere se o master anunciado pela página existe mesmo no CDN.
     *
     * O Hide continua servindo a página e assinando um token válido para
     * arquivos que já saíram do storage: o CDN responde 404 (com token inválido
     * responderia 403). Sem esta checagem a extração "dá certo" e quem descobre
     * o problema é o player, que trava sem dizer por quê. Falha de rede aqui não
     * invalida o stream.
     */
    private suspend fun hideMasterSumiu(streamUrl: String, referer: String): Boolean =
        withContext(Dispatchers.IO) {
            try {
                val request = Request.Builder()
                    .url(streamUrl)
                    .addHeader("User-Agent", UA_NATIVE)
                    .addHeader("Accept", "*/*")
                    .addHeader("Referer", referer)
                    .addHeader("Origin", "https://" + URL(referer).host)
                    .build()
                ObaflixApp.httpClient.newCall(request).execute().use { resposta ->
                    resposta.code == 404 || resposta.code == 410
                }
            } catch (e: Exception) {
                false
            }
        }

    suspend fun extractHide(embedUrl: String, id: String): NativeExtractResult {
        val falhas = mutableListOf<String>()
        var html: String? = null
        // O referer precisa ser a página do espelho que realmente respondeu:
        // quando a URL recebida aponta para um domínio morto (playhide.shop) e a
        // extração cai para hidehide.shop, mandar o domínio morto é falso.
        var paginaUsada = embedUrl

        // O host da URL recebida vem primeiro: é o que o provedor está anunciando
        // agora. Website e Electron ja faziam isso; so o Android seguia a ordem
        // fixa e seria o ultimo a acompanhar a proxima migracao de dominio.
        val recebido = try { URL(embedUrl).host.lowercase() } catch (_: Exception) { "" }
        val ordem = if (HIDE_HOSTS.contains(recebido)) {
            listOf(recebido) + HIDE_HOSTS.filter { it != recebido }
        } else {
            HIDE_HOSTS
        }

        for (host in ordem) {
            val alvo = "https://$host/v/$id"
            try {
                html = fetchHtml(alvo, REFERER_DEFAULT)
                paginaUsada = alvo
                if (host != ordem.first()) {
                    ObaLog.alerta(ObaLog.Fase.PROVEDOR, "hide_espelho_usado", "host" to host)
                }
                break
            } catch (e: Exception) {
                val motivo = NetworkDiagnostics.describe(e, alvo)
                falhas.add("$host: $motivo")
                ObaLog.alerta(ObaLog.Fase.PROVEDOR, "hide_espelho_fora", "host" to host, "motivo" to motivo)
            }
        }

        if (html == null) {
            throw Exception("PlayHide indisponivel em todos os espelhos — ${falhas.joinToString(" | ").take(300)}")
        }

        val evalScript = extractEvalScript(html) ?: throw Exception("packer não encontrado (PlayHide)")

        val direct = directDecodePacker(evalScript)
        val stream = direct?.let { parseDecodedHide(it, paginaUsada) }
            ?: parseDecodedHide(moon(evalScript), paginaUsada)
            ?: throw Exception("stream não encontrado (PlayHide)")

        if (hideMasterSumiu(stream, paginaUsada)) {
            ObaLog.alerta(ObaLog.Fase.PROVEDOR, "hide_arquivo_removido", "cdn" to ObaLog.url(stream))
            throw Exception("PlayHide não tem mais este arquivo — escolha outro servidor")
        }

        return NativeExtractResult(stream = stream, referer = paginaUsada)
    }

    suspend fun extractLulu(embedUrl: String): String {
        val html = fetchHtml(embedUrl, REFERER_DEFAULT)
        val evalScript = extractEvalScript(html) ?: throw Exception("packer não encontrado (Lulu)")
        val decoded = moon(evalScript)
        val src = decoded.split("[{file:\"").getOrNull(1)?.split("\"")?.getOrNull(0)
        if (src != null && src.startsWith("http")) return src
        return findM3u8(decoded) ?: throw Exception("stream não encontrado (Lulu)")
    }

    suspend fun extractRola2(id: String): String =
        postPlayer("https://llanfairpwllgwyngy.com/player/index.php", id)
            ?: throw Exception("stream não encontrado (Rola2)")

    suspend fun extractWish(embedUrl: String, id: String): String {
        val html = fetchHtml(embedUrl, REFERER_DEFAULT)

        if (id.isNotEmpty()) {
            try {
                val body = FormBody.Builder().add("hash", id).add("r", "").add("do", "getVideo").build()
                val request = Request.Builder()
                    .url(embedUrl)
                    .post(body)
                    .addHeader("User-Agent", UA_NATIVE)
                    .addHeader("Referer", REFERER_DEFAULT)
                    .addHeader("X-Requested-With", "XMLHttpRequest")
                    .build()
                val response = withContext(Dispatchers.IO) { ObaflixApp.httpClient.newCall(request).execute() }
                if (response.isSuccessful) {
                    val text = response.body?.string()
                    if (text != null) {
                        val json = JSONObject(text)
                        val src = json.optJSONArray("sources")?.optJSONObject(0)?.optString("file")
                            ?: json.optJSONArray("source")?.optJSONObject(0)?.optString("file")
                            ?: json.optString("videoSource").takeIf { it.isNotEmpty() }
                            ?: json.optString("src").takeIf { it.isNotEmpty() }
                        if (src != null && src.startsWith("http")) return src
                    }
                }
            } catch (_: Exception) { /* tenta métodos seguintes */ }
        }

        findM3u8(html)?.let { return it }

        val fileSplit = html.split("[{file:\"").getOrNull(1)?.split("\"")?.getOrNull(0)
        if (fileSplit != null && fileSplit.startsWith("http")) return fileSplit

        val jwMatch = Regex("""sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']""", RegexOption.IGNORE_CASE).find(html)
        if (jwMatch != null && jwMatch.groupValues[1].startsWith("http")) return jwMatch.groupValues[1]

        val jsonFile = Regex(""""file"\s*:\s*"(https?://[^"]+\.m3u8[^"]*)"""", RegexOption.IGNORE_CASE).find(html)
        if (jsonFile != null) return jsonFile.groupValues[1]

        val evalScript = extractEvalScript(html)
        if (evalScript != null) {
            val direct = directDecodePacker(evalScript)
            direct?.let { parseDecodedHide(it, embedUrl) }?.let { return it }
            val decoded = moon(evalScript)
            parseDecodedHide(decoded, embedUrl)?.let { return it }
        }
        throw Exception("stream não encontrado (Wish)")
    }

    suspend fun extractBolt(embedUrl: String): String {
        val html = fetchHtml(embedUrl, REFERER_DEFAULT)
        val src = html.split("[{file:\"").getOrNull(1)?.split("\"")?.getOrNull(0)
        if (src == null || !src.startsWith("http")) throw Exception("stream não encontrado (Bolt)")
        return src
    }

    suspend fun extractBig(embedUrl: String): String {
        val html = fetchHtml(embedUrl, REFERER_DEFAULT)
        val src = html.split("url: '").getOrNull(1)?.split("'")?.getOrNull(0)
        if (src == null || !src.startsWith("http")) throw Exception("stream não encontrado (Big)")
        return src
    }

    suspend fun extractWatchplayer(embedUrl: String): String {
        val parsed = URL(embedUrl)
        val parts = parsed.path.split("/").filter { it.isNotEmpty() }
        val html = fetchHtml(embedUrl, REFERER_DEFAULT)

        suspend fun callApi(params: Map<String, String>): JSONObject =
            withContext(Dispatchers.IO) {
                val bodyBuilder = FormBody.Builder()
                params.forEach { (key, value) -> bodyBuilder.add(key, value) }

                val request = Request.Builder()
                    .url("https://v1.watchplay.shop/api")
                    .post(bodyBuilder.build())
                    .addHeader("User-Agent", UA_NATIVE)
                    .addHeader("X-Requested-With", "XMLHttpRequest")
                    .addHeader("Referer", embedUrl)
                    .build()

                val response = ObaflixApp.httpClient.newCall(request).execute()
                val responseText = response.body?.string() ?: ""

                if (!response.isSuccessful) {
                    throw Exception("WatchPlay API HTTP ${response.code}")
                }

                JSONObject(responseText)
            }

        val videoId = if (parts.firstOrNull() == "tvshow") {
            val season = parts.getOrNull(2)
                ?: throw Exception("temporada nao encontrada (WatchPlay)")
            val episode = parts.getOrNull(3)
                ?: throw Exception("episodio nao encontrado (WatchPlay)")

            val contentId = Regex(
                """data-contentid=["'](\d+)["']\s+data-season=["']${Regex.escape(season)}["']\s+data-episode=["']${Regex.escape(episode)}["']"""
            ).find(html)?.groupValues?.getOrNull(1)
                ?: throw Exception("episodio nao encontrado (WatchPlay)")

            val optionsJson = callApi(
                mapOf(
                    "action" to "getOptions",
                    "contentid" to contentId,
                )
            )

            optionsJson
                .optJSONObject("data")
                ?.optJSONArray("options")
                ?.optJSONObject(0)
                ?.optString("ID")
                ?.takeIf { it.isNotEmpty() }
                ?: throw Exception("opcoes nao encontradas (WatchPlay)")
        } else {
            Regex(
                """class=["']player_select_item["']\s+data-id=["'](\d+)["']"""
            ).find(html)?.groupValues?.getOrNull(1)
                ?: throw Exception("player nao encontrado (WatchPlay)")
        }

        val playerJson = callApi(
            mapOf(
                "action" to "getPlayer",
                "video_id" to videoId,
            )
        )

        val bruta = playerJson
            .optJSONObject("data")
            ?.optString("video_url")
            ?.takeIf { it.isNotEmpty() }
            ?: throw Exception("stream nao encontrado (WatchPlay)")

        return assinarUrlDoCdn(embedUrl, bruta)
    }

    /**
     * Assina a URL do CDN, que a recusa sem assinatura.
     *
     * O `video_url` que a API devolve vem **cru**, e o CDN responde 403 a ele.
     * Quem assina e a propria pagina do embed: o JavaScript dela chama a si
     * mesma com `action_secure_sign=1&raw_url=<url>` e recebe
     * `{"signed_url": "...?md5=...&expires=..."}`. Quem abre a pagina num
     * navegador ganha esse passo de graca; a extracao nativa pegava a URL crua
     * e pulava a assinatura — por isso o provedor funcionava no site e falhava
     * com 403 no Electron, no movel nativo e na TV, sempre no mesmo CDN.
     *
     * Comprovado em campo: a mesma playlist devolve 403 crua e 200 assinada. Os
     * segmentos e o `init.mp4` sao abertos, entao basta assinar a playlist — o
     * Media3 resolve os segmentos por caminho relativo e eles passam.
     *
     * Falhar aqui devolve a URL crua, que e o mesmo que a pagina faz no `error`
     * do AJAX dela: melhor tentar e o player decidir do que abortar a fonte.
     */
    private suspend fun assinarUrlDoCdn(embedUrl: String, urlBruta: String): String =
        withContext(Dispatchers.IO) {
            if (urlBruta.contains("md5=")) return@withContext urlBruta
            val host = runCatching { URL(urlBruta).host.orEmpty() }.getOrDefault("")
            // Mesmo alvo que o JavaScript da pagina confere antes de assinar.
            if (!host.endsWith("hclod.qzz.io")) return@withContext urlBruta

            val separador = if (embedUrl.contains('?')) "&" else "?"
            val alvo = embedUrl + separador + "action_secure_sign=1&raw_url=" +
                java.net.URLEncoder.encode(urlBruta, "UTF-8")

            runCatching {
                val requisicao = Request.Builder()
                    .url(alvo)
                    .get()
                    .addHeader("User-Agent", UA_NATIVE)
                    .addHeader("Referer", embedUrl)
                    .addHeader("X-Requested-With", "XMLHttpRequest")
                    .addHeader("Accept", "application/json, text/plain, */*")
                    .build()
                ObaflixApp.httpClient.newCall(requisicao).execute().use { r ->
                    if (!r.isSuccessful) return@use urlBruta
                    val assinada = JSONObject(r.body?.string().orEmpty())
                        .optString("signed_url")
                        .takeIf { it.isNotBlank() }
                        ?: return@use urlBruta
                    ObaLog.evento(
                        ObaLog.Fase.EXTRACAO, "cdn_url_assinada",
                        "host" to ObaLog.host(assinada),
                    )
                    assinada
                }
            }.getOrElse {
                ObaLog.alerta(
                    ObaLog.Fase.EXTRACAO, "cdn_assinatura_falhou",
                    "host" to host, "erro" to it.javaClass.simpleName,
                )
                urlBruta
            }
        }

    // ── Router ────────────────────────────────────────────────────────────────

    // Mantido em sincronia com detectProvider() em desktop/electron/extractors.js e
    // supportsNativeDesktopExtraction() em src/components/player/CustomPlayer.tsx.
    fun detectProvider(embedUrl: String): String? {
        val parsed = try { URL(embedUrl) } catch (_: Exception) { return null }
        val host = parsed.host ?: ""
        val path = parsed.path ?: ""
        if (parsed.protocol != "https") return null
        fun hostIs(vararg allowed: String): Boolean = allowed.any { host == it || host.endsWith(".$it") }

        if (hostIs("playerflix.ink") && path.contains("/inc/Ajax.php")) return "playerflix"
        if (hostIs("embedplayer1.xyz", "embedplayer2.xyz", "xn--kcksk7a2bl5le7b6doc1h3f.com", "xn--tckasiu6cvova0eb5fua2449g98vg.best")) return "embedplayer"
        if (hostIs("megafrixapi.com", "vods.faz-o-eli.online") && path.contains("voltz.php")) return "voltz"
        if (hostIs("luluvdo.com", "lulu.gg", "luluvid.com", "lulustream.com")) return "lulu"
        if (hostIs("playhide.shop", "hidehide.shop", "vidhidehub.com")) return "hide"
        if (hostIs("streamwish.com", "playerwish.com", "hlswish.com", "wishonly.site", "cdnwish.com", "asnwish.com", "swishsrv.com")) return "wish"
        if (hostIs("llanfairpwllgwyngy.com")) return "rola2"
        if (hostIs("boltcdn.xyz", "upbolt.to")) return "bolt"
        if (hostIs("bigshare.link")) return "big"
        if (hostIs("v1.watchplay.shop")) return "watchplayer"
        if (hostIs("superflixapi.pro", "superflixapi.sbs", "superflixapi.beer")) return "superflix"
        if (hostIs("redecanais.capital") && RedeCanaisExtractor.isSupportedUrl(embedUrl)) return "redecanais"
        return null
    }

    suspend fun extractResult(embedUrl: String): NativeExtractResult {
        val provider = detectProvider(embedUrl)
            ?: throw Exception("Provider não suportado nativamente: ${embedUrl.take(60)}")
        val parsed = URL(embedUrl)
        val id = parsed.path.split("/").lastOrNull { it.isNotEmpty() } ?: ""

        if (provider == "superflix") return SuperflixExtractor.extract(embedUrl)
        if (provider == "playerflix") return extractPlayerflix(embedUrl)

        if (provider == "hide") return extractHide(embedUrl, id)

        val stream = when (provider) {
            "voltz" -> extractVoltz(embedUrl)
            "embedplayer" -> extractEmbedPlayer(embedUrl)
            "lulu" -> extractLulu(embedUrl)
            "rola2" -> extractRola2(id)
            "wish" -> extractWish(embedUrl, id)
            "bolt" -> extractBolt(embedUrl)
            "big" -> extractBig(embedUrl)
            "watchplayer" -> extractWatchplayer(embedUrl)
            else -> throw Exception("Provider sem extrator: $provider")
        }
        return NativeExtractResult(stream = stream, referer = embedUrl)
    }

    suspend fun extract(embedUrl: String): String = extractResult(embedUrl).stream
}
