package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.servers.ServerException
import com.nuvio.app.features.servers.ServerFailure
import com.nuvio.app.features.servers.ServerItemRef
import com.nuvio.app.features.servers.ServerPlaybackTarget
import com.nuvio.app.features.streams.StreamItem
import com.nuvio.app.features.streams.StreamProxyHeaders
import com.nuvio.app.features.streams.StreamSubtitle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.time.Duration.Companion.seconds

/** What the device extractor produced from an embed page. */
data class ExtractedMedia(
    val url: String,
    val referer: String?,
    val userAgent: String?,
    val isHls: Boolean,
    val subtitles: List<Pair<String, String>> = emptyList(),
)

/**
 * The official mobile/TV source flow, step for step (see android/tv FontesTv):
 *  1. `/api/player/fontes` (ambiente android) with the gate's single-use proof;
 *  2. `/api/player/fonte-nativa` for ONE server, walking its coordinates (max 4);
 *  3. `streamUrl` is used as is; `embedUrl` is extracted on the device by the official extractor.
 * Servers that need a visible WebView challenge are not offered, as on the TV.
 */
internal object ObaflixNativeSources : ObaflixNativeSourceProvider {
    private val extractTimeout = 45.seconds
    private const val MAX_COORDINATES = 4

    /** Network seam (status, body), replaced in tests. */
    internal var post: suspend (String, String) -> Pair<Int, String> = { path, body ->
        ObaflixSession.authedRequest("POST", path, body).let { it.status to it.body }
    }

    /** Device extractor; set by the Android application. */
    internal var extractor: (suspend (String) -> ExtractedMedia)? = null

    override suspend fun list(ref: ObaflixRef): List<StreamItem> {
        val decision = ObaflixPlaybackGate.authorize(ref)
        if (decision is GateDecision.Blocked) throw ServerException(ServerFailure.FORBIDDEN, decision.message)
        return fetchServers(ref, ObaflixPlaybackGate.REPRODUCAO)
    }

    /** The server list for "Transmitir"/"Baixar": the caller has already obtained the grant of [purpose] (one ad at most). */
    internal suspend fun listForAction(ref: ObaflixRef, purpose: String): List<StreamItem> = fetchServers(ref, purpose)

    private suspend fun fetchServers(ref: ObaflixRef, purpose: String): List<StreamItem> {
        var (status, body) = post("/api/player/fontes", fontesBody(ref, ObaflixPlaybackGate.takeToken(ref, purpose), purpose))
        if (status == 403 && code(body) == "anuncio_necessario") {
            // Proof spent or absent: an already-paid target gets a new pass without a second ad.
            val renewed = ObaflixPlaybackGate.renew(ref, purpose)
            if (renewed is GateDecision.Blocked) throw ServerException(ServerFailure.FORBIDDEN, renewed.message)
            val retry = post("/api/player/fontes", fontesBody(ref, ObaflixPlaybackGate.takeToken(ref, purpose), purpose))
            status = retry.first
            body = retry.second
        }
        if (status == 401) {
            com.nuvio.app.core.auth.AuthRepository.onObaflixSessionRejected()
            throw ServerException(ServerFailure.AUTH_REQUIRED)
        }
        if (status != 200) throw ServerException(ServerFailure.FORBIDDEN, "Servidores Obaflix indisponíveis.")
        return parseFontes(body)
    }

    override suspend fun prepare(stream: StreamItem): StreamItem {
        val target = stream.serverTarget ?: return stream
        val session = target.item.itemId
        val serverId = target.mediaSourceId ?: throw ServerException(ServerFailure.NOT_FOUND)
        var coordinate = 0
        var total = 1
        while (coordinate < minOf(total, MAX_COORDINATES)) {
            val (status, body) = post("/api/player/fonte-nativa", fonteNativaBody(session, serverId, coordinate))
            if (status == 401) {
                com.nuvio.app.core.auth.AuthRepository.onObaflixSessionRejected()
                throw ServerException(ServerFailure.AUTH_REQUIRED)
            }
            // Expired source session: the caller moves on; a new list opens a new authorized session.
            if (status != 200) throw ServerException(ServerFailure.FORBIDDEN, "Sessão de fontes expirada.")
            val root = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()
                ?: throw ServerException(ServerFailure.FORBIDDEN)
            total = (root["tentativas"] as? JsonPrimitive)?.intOrNull?.coerceIn(1, MAX_COORDINATES) ?: 1
            resolve(root)?.let { media -> return stream.withMedia(media) }
            coordinate++
        }
        throw ServerException(ServerFailure.NOT_FOUND, "Servidor sem mídia disponível.")
    }

    private suspend fun resolve(root: JsonObject): ExtractedMedia? {
        val subtitles = (root["legendas"] as? JsonArray).orEmpty().mapNotNull { e ->
            val o = e as? JsonObject ?: return@mapNotNull null
            val file = o.str("url") ?: o.str("file") ?: return@mapNotNull null
            file to (o.str("label") ?: o.str("language") ?: "Legenda")
        }.filter { it.first.startsWith("https://") }
        root.str("streamUrl")?.let { url ->
            if (!url.startsWith("https://")) return null
            return ExtractedMedia(url, root.str("referer"), null, looksHls(url), subtitles)
        }
        val embed = root.str("embedUrl") ?: return null
        val extract = extractor ?: return null
        return try {
            withTimeoutOrNull(extractTimeout) { extract(embed) }
                ?.takeIf { it.url.startsWith("https://") }
                ?.let { it.copy(subtitles = it.subtitles + subtitles) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null // provider failed: next coordinate, then the next server
        }
    }

    internal fun fontesBody(ref: ObaflixRef, proof: String?, purpose: String = ObaflixPlaybackGate.REPRODUCAO): String = buildJsonObject {
        put("conteudoId", ref.id)
        put("conteudoTipo", ref.tipo)
        ref.season?.let { put("temporada", it) }
        ref.episode?.let { put("numeroEp", it) }
        put("ambiente", "android")
        put("plataforma", ObaflixConfig.PLATFORM)
        put("finalidade", purpose)
        put("desafioInterativo", false) // no visible-WebView challenge in the native player
        proof?.let { put("concessao", it) }
    }.toString()

    internal fun fonteNativaBody(session: String, serverId: String, coordinate: Int): String = buildJsonObject {
        put("sessao", session)
        put("fonteId", serverId)
        if (coordinate > 0) put("tentativa", coordinate)
    }.toString()

    internal fun parseFontes(body: String): List<StreamItem> {
        val root = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()
            ?: throw ServerException(ServerFailure.FORBIDDEN)
        val session = root.str("sessao") ?: throw ServerException(ServerFailure.FORBIDDEN)
        return (root["fontes"] as? JsonArray).orEmpty().mapNotNull { e ->
            val f = e as? JsonObject ?: return@mapNotNull null
            val id = f.str("id") ?: return@mapNotNull null
            val usable = f.bool("disponivel") && (f.bool("nativo") || f.bool("resolvidoNoServidor")) &&
                !f.bool("iframeDesafio")
            if (!usable) return@mapNotNull null
            val language = when (f.str("idioma")) {
                "dub" -> "Dublado"
                "leg" -> "Legendado"
                else -> null
            }
            // The server label ("Servidor N") is the protection: no provider name is invented here.
            val label = listOfNotNull(f.str("rotulo") ?: "Servidor", language).joinToString(" · ")
            StreamItem(
                name = label,
                sourceName = ObaflixNative.LABEL,
                addonName = ObaflixNative.LABEL,
                addonId = ObaflixNative.GROUP_ID,
                serverTarget = ServerPlaybackTarget(ServerItemRef(ObaflixNative.CONNECTION_ID, session), id),
            )
        }
    }

    private fun StreamItem.withMedia(media: ExtractedMedia): StreamItem {
        val headers = buildMap {
            media.referer?.let { put("Referer", it) }
            media.userAgent?.let { put("User-Agent", it) }
        }
        return copy(
            url = media.url,
            streamType = if (media.isHls) "hls" else streamType,
            externalSubtitles = externalSubtitles + media.subtitles.map { (url, label) ->
                StreamSubtitle(url = url, language = label, name = label)
            },
            behaviorHints = behaviorHints.copy(
                proxyHeaders = headers.takeIf { it.isNotEmpty() }?.let { StreamProxyHeaders(request = it) },
            ),
        )
    }

    private fun code(body: String): String? =
        runCatching { Json.parseToJsonElement(body).jsonObject.str("codigo") }.getOrNull()

    internal fun looksHls(url: String): Boolean {
        val path = url.substringBefore('?').lowercase()
        return path.endsWith(".m3u8") || path.contains(".urlset/") || path.endsWith("/master.txt")
    }
}

private fun JsonObject.str(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() && it != "null" }

private fun JsonObject.bool(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull == true

