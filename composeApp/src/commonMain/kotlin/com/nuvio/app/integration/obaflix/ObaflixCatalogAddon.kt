package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.addons.httpGetText
import com.nuvio.app.features.home.MetaPreview
import io.ktor.http.decodeURLPart
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes

/**
 * The Obaflix catalog spoken in the Stremio addon protocol that Nuvio's Home/Search/Details already
 * consume. Data comes only from Obaflix's public catalog API (DB + server-side TMDB cache), with
 * canonical Obaflix IDs (`obaflix:filme:<id>`, `obaflix:serie:<id>[:<season>:<episode>]`).
 *
 * shortcut: translated in-process from the existing public routes; move the same JSON to a backend
 * route at [ObaflixConfig.CATALOG_ADDON_MANIFEST_URL] to get CDN caching and one implementation.
 */
internal object ObaflixCatalogAddon {
    private val base = ObaflixConfig.CATALOG_ADDON_MANIFEST_URL.removeSuffix("/manifest.json")
    private const val PAGE_SIZE = 24
    private const val ID_PREFIX = "obaflix:"
    private val cacheTtl = 10.minutes

    /** After a failed refresh the stale copy is served and not retried for this long (no request storm while offline or on 5xx). */
    private val retryBackoff = 1.minutes

    /** A title sheet saved on disk this recently is reused after a cold start without a request. */
    private const val DISK_FRESH_MS = 2 * 60 * 60 * 1000L

    /** Network seam, replaced in tests. */
    internal var fetch: suspend (String) -> String = ::httpGetText

    private val cacheLock = Mutex()
    private val cache = LinkedHashMap<String, Pair<kotlin.time.Instant, JsonElement>>()

    /** One network call per path at a time: Home rows sharing `/api/tv/home` await the same request. */
    private val inFlight = HashMap<String, Deferred<JsonElement>>()
    private val loader = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Public (non-personal) ranking kept on disk so a cold start shows the last Home at once. */
    private const val PERSISTED_PATH = "/api/tv/home"

    /** Public title sheets (`/api/filmes/{id}`, `/api/series/{id}[/...]`) are kept on disk too; lists, search and per-account data are not. */
    /** Disk entries are tagged with the catalog origin, so a copy fetched from another origin is never reused. */
    // Stable across host fallbacks: the same cached JSON is valid whichever official host served it.
    internal fun diskKey(path: String) = "cat-" + ObaflixConfig.PRODUCTION_BASE_URL.removePrefix("https://") + path

    private fun persistable(path: String): Boolean =
        path == PERSISTED_PATH ||
            ((path.startsWith("/api/filmes/") || path.startsWith("/api/series/")) && '?' !in path && '#' !in path)

    /** Disk store installed by the Android app; null = memory only (tests, other platforms). */
    internal var disk: ObaflixDiskCache? = null

    /** Called after a cold start served the disk copy and the fresh ranking differs (Home re-reads memory). */
    internal var onSharedRowsRefreshed: (() -> Unit)? = null

    fun handles(url: String): Boolean = url.substringBefore('?').startsWith("$base/")

    suspend fun respond(url: String): String {
        val path = url.substringBefore('?').removePrefix("$base/").removeSuffix(".json")
        val raw = path.split('/')
        val parts = raw.map { it.decodeURLPart() }
        return when {
            path == "manifest" -> manifest().toString()
            // extras stay raw here: parseExtra decodes each value exactly once
            parts.size >= 3 && parts[0] == "catalog" -> catalog(parts[1], parts[2], parseExtra(raw.getOrNull(3))).toString()
            parts.size == 3 && parts[0] == "meta" -> meta(parts[2]).toString()
            else -> error("Recurso não oferecido pelo catálogo Obaflix: ${parts.firstOrNull()}")
        }
    }

    /** IMDb-based id that third-party stream/subtitle addons understand, or null when the title has none. */
    suspend fun addonVideoId(videoId: String): String? {
        val ref = ObaflixRef.parse(videoId) ?: return null
        val imdb = getJson(ref.detailPath()).jsonObject.str("imdbId")?.takeIf { it.startsWith("tt") } ?: return null
        return if (ref.season != null && ref.episode != null) "$imdb:${ref.season}:${ref.episode}" else imdb
    }

    /**
     * "More like this" from Obaflix itself, never a third party. Series: the existing
     * `/api/series/{id}/recomendacoes` (server-side recommendations limited to the Obaflix catalog).
     * Movies have no such route yet, so: popular titles of the same genre from `/api/filmes`.
     */
    suspend fun similar(id: String, limit: Int = 15): List<MetaPreview> {
        val ref = ObaflixRef.parse(id) ?: return emptyList()
        val rows = if (ref.tipo == "serie") {
            getJson("/api/series/${ref.id}/recomendacoes").jsonObject["items"]?.jsonArray.orEmpty()
        } else {
            val genre = (getJson(ref.detailPath()).jsonObject["generos"] as? JsonArray).orEmpty()
                .firstNotNullOfOrNull { (it as? JsonObject)?.get("genero")?.jsonObject?.str("id") }
                ?: return emptyList()
            getJson("/api/filmes?page=1&ordem=popular&genero=$genre").jsonObject["filmes"]?.jsonArray.orEmpty()
        }
        return rows.asSequence()
            .mapNotNull { it as? JsonObject }
            .filter { it.str("id") != ref.id }
            .mapNotNull { row -> toPreview(row, ref.tipo)?.toMetaPreview() }
            .take(limit)
            .toList()
    }

    private fun JsonObject.toMetaPreview(): MetaPreview? {
        val id = str("id") ?: return null
        return MetaPreview(
            id = id,
            type = str("type") ?: return null,
            name = str("name") ?: return null,
            poster = str("poster"),
            banner = str("background"),
            logo = str("logo"),
            description = str("description"),
            releaseInfo = str("releaseInfo"),
            imdbRating = str("imdbRating"),
        )
    }

    /** Obaflix episode row id, needed by `/api/progress` to key series history per episode. */
    suspend fun episodeId(serieId: String, season: Int, episode: Int): String? =
        getJson("/api/series/$serieId/episodios").jsonArray
            .map { it.jsonObject }
            .firstOrNull { it.str("temporada")?.toIntOrNull() == season && it.str("numeroEp")?.toIntOrNull() == episode }
            ?.str("id")

    internal fun manifest(): JsonObject = buildJsonObject {
        put("id", MANIFEST_ID)
        put("version", "1.0.0")
        put("name", "Obaflix")
        put("description", "Catálogo Obaflix")
        putJsonArray("types") { add("movie"); add("series") }
        putJsonArray("idPrefixes") { add(ID_PREFIX) }
        putJsonArray("resources") {
            add("catalog")
            add(buildJsonObject {
                put("name", "meta")
                putJsonArray("types") { add("movie"); add("series") }
                putJsonArray("idPrefixes") { add(ID_PREFIX) }
            })
        }
        putJsonArray("catalogs") {
            CATALOGS.forEach { c ->
                add(buildJsonObject {
                    put("type", c.type)
                    put("id", c.id)
                    put("name", c.name)
                    when (c.source) {
                        Source.PAGED -> putJsonArray("extra") {
                            add(buildJsonObject { put("name", "skip") })
                            // Genre / year filters reuse Nuvio's "genre" selector; "Por ano" requires it (Discover only).
                            c.filter.options(c.type)?.let { options ->
                                add(buildJsonObject {
                                    put("name", "genre")
                                    put("isRequired", c.filter == Filter.YEAR)
                                    putJsonArray("options") { options.forEach { add(it) } }
                                })
                            }
                            if (c.filter.hasYearExtra) {
                                add(buildJsonObject {
                                    put("name", "year")
                                    putJsonArray("options") { yearOptions().forEach { add(it) } }
                                })
                            }
                        }
                        Source.SEARCH -> putJsonArray("extra") {
                            add(buildJsonObject { put("name", "search"); put("isRequired", true) })
                        }
                        Source.HOME, Source.RECS -> Unit
                    }
                })
            }
        }
        putJsonObject("behaviorHints") { put("configurable", false) }
    }

    private suspend fun catalog(type: String, id: String, extra: Map<String, String>): JsonObject {
        val def = CATALOGS.firstOrNull { it.type == type && it.id == id } ?: return metas(emptyList())
        val tipo = if (type == "movie") "filme" else "serie"
        val rows: List<JsonElement> = when (def.source) {
            Source.HOME -> getJson("/api/tv/home").jsonObject[def.homeKey!!]?.jsonArray.orEmpty()
            Source.RECS -> if (ObaflixConfig.catalogoSeparado) emptyList() else recommendationRow(def.homeKey!!)
            Source.PAGED -> {
                val page = (extra["skip"]?.toIntOrNull() ?: 0) / PAGE_SIZE + 1
                val list = if (type == "movie") "filmes" else "series"
                val filter = def.filter.queryParam(type, extra["genre"])
                val year = extra["year"]?.takeIf { def.filter.hasYearExtra }?.let { Filter.YEAR.queryParam(type, it) }
                if (filter == null && def.filter == Filter.YEAR) emptyList()
                else getJson("/api/$list?page=$page${def.query}${filter.orEmpty()}${year.orEmpty()}").jsonObject[list]?.jsonArray.orEmpty()
            }
            Source.SEARCH -> {
                val q = extra["search"]?.trim().orEmpty()
                if (q.length < 2) emptyList() else {
                    val key = if (type == "movie") "filmes" else "series"
                    getJson("/api/search?q=${q.encodeURLParameter()}").jsonObject[key]?.jsonArray.orEmpty()
                }
            }
        }
        // Mixed rows ("Em alta", recommendations) say per item whether it is a film or a series.
        return metas(rows.mapNotNull { row ->
            val itemTipo = row.jsonObject.str("tipo")?.let { if (it == "filme") "filme" else "serie" } ?: tipo
            toPreview(row.jsonObject, itemTipo)
        })
    }

    private suspend fun meta(id: String): JsonObject {
        val ref = ObaflixRef.parse(id) ?: error("ID fora do catálogo Obaflix")
        val detail = getJson(ref.detailPath()).jsonObject
        val preview = toPreview(detail, ref.tipo) ?: error("Título sem identificador")
        val episodes = if (ref.tipo == "serie") getJson("/api/series/${ref.id}/episodios").jsonArray else null
        return buildJsonObject {
            putJsonObject("meta") {
                preview.forEach { (k, v) -> put(k, v) }
                detail.str("duracao")?.let { put("runtime", "$it min") }
                detail.str("imdbId")?.let { put("imdb_id", it) }
                if (episodes != null) {
                    put("videos", buildJsonArray {
                        episodes.forEach { e -> toVideo(e.jsonObject, ref.id)?.let(::add) }
                    })
                } else {
                    putJsonObject("behaviorHints") { put("defaultVideoId", preview["id"]!!) }
                }
            }
        }
    }

    internal fun toPreview(row: JsonObject, tipo: String): JsonObject? {
        val id = row.str("id") ?: return null
        val name = row.str("titulo") ?: return null
        return buildJsonObject {
            put("id", "$ID_PREFIX$tipo:$id")
            put("type", if (tipo == "filme") "movie" else "series")
            put("name", name)
            image(row.str("poster"), "w500")?.let { put("poster", it) }
            image(row.str("background"), "w1280")?.let { put("background", it) }
            image(row.str("logo"), "w500")?.let { put("logo", it) }
            row.str("sinopse")?.let { put("description", it) }
            row.str("ano")?.let { put("releaseInfo", it) }
            row.str("nota")?.toDoubleOrNull()?.takeIf { it > 0 }?.let {
                put("imdbRating", ((it * 10).toInt() / 10.0).toString())
            }
            val genres = (row["generos"] as? JsonArray).orEmpty().mapNotNull {
                (it as? JsonObject)?.get("genero")?.jsonObject?.str("nome")
            }
            if (genres.isNotEmpty()) putJsonArray("genres") { genres.forEach { add(it) } }
        }
    }

    internal fun toVideo(e: JsonObject, serieId: String): JsonObject? {
        val season = e.str("temporada")?.toIntOrNull() ?: return null
        val episode = e.str("numeroEp")?.toIntOrNull() ?: return null
        return buildJsonObject {
            put("id", "${ID_PREFIX}serie:$serieId:$season:$episode")
            put("title", e.str("titulo") ?: "Episódio $episode")
            put("season", season)
            put("episode", episode)
            image(e.str("thumbnail"), "w500")?.let { put("thumbnail", it) }
            e.str("createdAt")?.let { put("released", it) }
        }
    }

    private fun metas(items: List<JsonObject>) = buildJsonObject { put("metas", JsonArray(items)) }

    private suspend fun getJson(
        path: String,
        fetchText: suspend () -> String = { ObaflixHostFallback.get(path, fetch) },
    ): JsonElement {
        val now = Clock.System.now()
        val pending = cacheLock.withLock {
            cache[path]?.let { (at, value) -> if (now - at < cacheTtl) return value }
            if (cache[path] == null && path != PERSISTED_PATH && persistable(path)) {
                // Cold start: a recent title sheet on disk answers without any request.
                val d = disk
                if (d != null && (d.ageMs(diskKey(path)) ?: Long.MAX_VALUE) < DISK_FRESH_MS) {
                    d.read(diskKey(path))?.let { text ->
                        runCatching { kotlinx.serialization.json.Json.parseToJsonElement(text) }.getOrNull()?.let {
                            cache[path] = now to it
                            return it
                        }
                    }
                }
            }
            val running = inFlight[path] ?: loader.async { load(path, fetchText) }.also { inFlight[path] = it }
            // Cold start: answer now with the last ranking on disk while `running` refreshes it.
            if (path == PERSISTED_PATH) {
                val stale = cache[path]?.second ?: disk?.read(diskKey(path))?.let {
                    runCatching { kotlinx.serialization.json.Json.parseToJsonElement(it) }.getOrNull()
                }
                if (stale != null) {
                    cache[path] = (now - cacheTtl) to stale // still expired: the next call joins the refresh
                    return stale
                }
            }
            running
        }
        return try {
            pending.await()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // Offline or backend error: keep showing the last valid copy instead of an empty screen.
            staleCopy(path) ?: throw e
        }
    }

    private suspend fun staleCopy(path: String): JsonElement? = cacheLock.withLock {
        val value = cache[path]?.second ?: if (persistable(path)) {
            disk?.read(diskKey(path))?.let { runCatching { kotlinx.serialization.json.Json.parseToJsonElement(it) }.getOrNull() }
        } else {
            null
        }
        value?.also { cache[path] = (Clock.System.now() - cacheTtl + retryBackoff) to it }
    }

    private suspend fun load(path: String, fetchText: suspend () -> String): JsonElement {
        try {
            val text = fetchText()
            val value = kotlinx.serialization.json.Json.parseToJsonElement(text)
            val servedStale = cacheLock.withLock {
                val previous = cache[path]?.second
                cache[path] = Clock.System.now() to value
                if (cache.size > 200) cache.remove(cache.keys.first())
                previous != null && previous != value
            }
            if (persistable(path)) disk?.write(diskKey(path), text)
            if (path == PERSISTED_PATH && servedStale) onSharedRowsRefreshed?.invoke()
            return value
        } catch (e: Exception) {
            if (e !is kotlinx.coroutines.CancellationException) cacheLock.withLock {
                cache[path]?.let { (_, stale) -> cache[path] = (Clock.System.now() - cacheTtl + retryBackoff) to stale }
            }
            throw e
        } finally {
            cacheLock.withLock { inFlight.remove(path) }
        }
    }

    internal fun clearCache() {
        cache.clear()
        inFlight.clear()
    }

    /** One `/api/recommendations` call (per account, cached and shared like the catalog) feeds all personal rows. */
    private suspend fun recommendationRow(rowId: String): List<JsonElement> {
        val session = ObaflixSession.current ?: return emptyList() // signed out: rows stay hidden
        val body = try {
            getJson("/api/recommendations#${session.userId}") {
                val response = ObaflixSession.authedRequest("GET", "/api/recommendations")
                check(response.status == 200) { "recommendations ${response.status}" }
                response.body
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            return emptyList() // offline / expired session: personal rows simply do not show
        }
        return body.jsonObject["rows"]?.jsonArray.orEmpty()
            .firstOrNull { it.jsonObject.str("id") == rowId }
            ?.jsonObject?.get("items")?.jsonArray.orEmpty()
    }

    /** HOME = `/api/tv/home` (one request for every ranked row); RECS = signed-in `/api/recommendations`. */
    private enum class Source { HOME, RECS, PAGED, SEARCH }

    /** Obaflix rows shown on Home, in the Electron order; every other catalog stays in Search/Descobrir. */
    internal const val HOME_PREFIX = "obaflix.home."
    internal const val TRENDING_ID = "${HOME_PREFIX}emalta"
    internal const val MANIFEST_ID = "online.obaflix.catalog"

    internal fun isHomeRow(manifestId: String, catalogId: String): Boolean =
        manifestId != MANIFEST_ID || catalogId.startsWith(HOME_PREFIX)

    /** Filter exposed through Nuvio's genre selector; values map to existing Obaflix API params. */
    internal enum class Filter {
        NONE, GENRE, YEAR,
        /** Search screen "Descobrir": optional genre + optional "year" extra. */
        DISCOVER,
        /** Same, year only (category already fixes the genre). */
        DISCOVER_YEAR_ONLY;

        val hasYearExtra: Boolean get() = this == DISCOVER || this == DISCOVER_YEAR_ONLY

        fun options(type: String): List<String>? = when (this) {
            NONE, DISCOVER_YEAR_ONLY -> null
            GENRE, DISCOVER -> genres(type).keys.toList()
            YEAR -> yearOptions()
        }

        /** "&genero=<tmdb id>" / "&ano=<year>"; null when nothing (valid) is selected. */
        fun queryParam(type: String, value: String?): String? = when (this) {
            NONE, DISCOVER_YEAR_ONLY -> null
            GENRE, DISCOVER -> value?.let { genres(type)[it] }?.let { "&genero=$it" }
            YEAR -> value?.toIntOrNull()?.takeIf { it in 1900..2100 }?.let { "&ano=$it" }
        }
    }

    private data class CatalogDef(
        val type: String,
        val id: String,
        val name: String,
        val source: Source,
        val homeKey: String? = null,
        /** Extra query for paged lists, e.g. "&ordem=nota&tipo=anime" (existing Obaflix API params). */
        val query: String = "",
        val filter: Filter = Filter.NONE,
    )

    private val CATALOGS = listOf(
        // Home, Electron order (D:\Obaflix web home + /api/tv/home + /api/recommendations).
        CatalogDef("movie", TRENDING_ID, "Em alta", Source.HOME, "emAlta"),
        CatalogDef("movie", "${HOME_PREFIX}filmes.populares", "Filmes populares", Source.HOME, "popularesFilmes"),
        CatalogDef("movie", "${HOME_PREFIX}filmes.top10", "Top 10 filmes de hoje", Source.HOME, "top10Filmes"),
        CatalogDef("movie", "${HOME_PREFIX}filmes.avaliados", "Filmes mais bem avaliados", Source.HOME, "avaliadosFilmes"),
        CatalogDef("series", "${HOME_PREFIX}series.populares", "Séries populares", Source.HOME, "popularesSeries"),
        CatalogDef("series", "${HOME_PREFIX}series.top10", "Top 10 séries hoje", Source.HOME, "top10Series"),
        CatalogDef("series", "${HOME_PREFIX}series.avaliadas", "Séries mais bem avaliadas", Source.HOME, "avaliadosSeries"),
        CatalogDef("series", "${HOME_PREFIX}animes.populares", "Animes populares", Source.PAGED, query = "&tipo=anime&ordem=popular"),
        // shortcut: no daily anime ranking exists in Obaflix; "Top 10 animes hoje" waits for one (backend).
        CatalogDef("series", "${HOME_PREFIX}animes.avaliados", "Animes mais bem avaliados", Source.PAGED, query = "&tipo=anime&ordem=nota"),
        CatalogDef("movie", "${HOME_PREFIX}parati", "Escolhidos para você", Source.RECS, "for-you"),
        CatalogDef("movie", "${HOME_PREFIX}porquegostou", "Por você gostar", Source.RECS, "because-seed"),
        CatalogDef("series", "${HOME_PREFIX}animeradar", "Animes para entrar no seu radar", Source.RECS, "anime-radar"),
        CatalogDef("movie", "${HOME_PREFIX}dublados", "Dublados para maratonar", Source.RECS, "dubbed"),
        CatalogDef("movie", "obaflix.filmes", "Todos os filmes", Source.PAGED),
        CatalogDef("series", "obaflix.series", "Todas as séries", Source.PAGED),
        CatalogDef("movie", "obaflix.filmes.populares", "Filmes populares", Source.PAGED, query = "&ordem=popular", filter = Filter.GENRE),
        CatalogDef("movie", "obaflix.filmes.nota", "Filmes bem avaliados", Source.PAGED, query = "&ordem=nota", filter = Filter.GENRE),
        CatalogDef("movie", "obaflix.filmes.novos", "Filmes por lançamento", Source.PAGED, query = "&ordem=lancamento", filter = Filter.GENRE),
        CatalogDef("movie", "obaflix.filmes.kids", "Kids", Source.PAGED, query = "&ordem=popular&genero=16"),
        CatalogDef("movie", "obaflix.filmes.ano", "Filmes por ano", Source.PAGED, query = "&ordem=popular", filter = Filter.YEAR),
        CatalogDef("series", "obaflix.series.populares", "Séries populares", Source.PAGED, query = "&tipo=serie&ordem=popular", filter = Filter.GENRE),
        CatalogDef("series", "obaflix.series.nota", "Séries bem avaliadas", Source.PAGED, query = "&tipo=serie&ordem=nota", filter = Filter.GENRE),
        CatalogDef("series", "obaflix.series.novas", "Séries por lançamento", Source.PAGED, query = "&tipo=serie&ordem=lancamento", filter = Filter.GENRE),
        CatalogDef("series", "obaflix.series.ano", "Séries por ano", Source.PAGED, query = "&tipo=serie&ordem=popular", filter = Filter.YEAR),
        CatalogDef("series", "obaflix.animes.populares", "Animes populares", Source.PAGED, query = "&tipo=anime&ordem=popular", filter = Filter.GENRE),
        CatalogDef("series", "obaflix.animes.nota", "Animes bem avaliados", Source.PAGED, query = "&tipo=anime&ordem=nota", filter = Filter.GENRE),
        CatalogDef("series", "obaflix.kids", "Kids: desenhos", Source.PAGED, query = "&tipo=desenho&ordem=popular", filter = Filter.GENRE),
    ) + ObaflixDiscover.categories.flatMap { category ->
        ObaflixDiscover.sorts.map { sort ->
            CatalogDef(
                category.type,
                ObaflixDiscover.catalogId(category, sort),
                sort.label,
                Source.PAGED,
                query = category.query + sort.query,
                filter = if (category.fixedGenre) Filter.DISCOVER_YEAR_ONLY else Filter.DISCOVER,
            )
        }
    } + listOf(
        CatalogDef("movie", "obaflix.busca", "Filmes", Source.SEARCH),
        CatalogDef("series", "obaflix.busca", "Séries", Source.SEARCH),
    )
}

/** Small key -> text store for public catalog responses (Android: app cache dir). */
internal interface ObaflixDiskCache {
    fun read(key: String): String?
    fun write(key: String, value: String)

    /** Milliseconds since [key] was written, or null when absent or unknown. */
    fun ageMs(key: String): Long? = null
}

/** Canonical Obaflix reference parsed from an addon id. */
internal data class ObaflixRef(val tipo: String, val id: String, val season: Int?, val episode: Int?) {
    fun detailPath() = if (tipo == "filme") "/api/filmes/$id" else "/api/series/$id"

    companion object {
        private val SAFE_ID = Regex("^[A-Za-z0-9_-]{1,64}$")

        fun parse(value: String): ObaflixRef? {
            val p = value.split(':')
            if (p.size < 3 || p[0] != "obaflix" || p[1] !in setOf("filme", "serie") || !SAFE_ID.matches(p[2])) return null
            return when {
                p.size == 3 -> ObaflixRef(p[1], p[2], null, null)
                p.size == 5 && p[1] == "serie" -> {
                    val s = p[3].toIntOrNull()?.takeIf { it >= 0 } ?: return null
                    val e = p[4].toIntOrNull()?.takeIf { it >= 0 } ?: return null
                    ObaflixRef(p[1], p[2], s, e)
                }
                else -> null
            }
        }
    }
}

internal fun parseExtra(segment: String?): Map<String, String> =
    segment.orEmpty().split('&').mapNotNull { pair ->
        val k = pair.substringBefore('=', "")
        if (k.isEmpty()) null else k to pair.substringAfter('=').decodeURLPart()
    }.toMap()

/** TMDB stores paths; Obaflix sometimes already stores a full URL. */
internal fun image(value: String?, size: String): String? = when {
    value.isNullOrBlank() || value == "null" -> null
    value.startsWith("https://") -> value
    value.startsWith("/") -> "https://image.tmdb.org/t/p/$size$value"
    else -> null
}

private fun JsonObject.str(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() && it != "null" }

/** Obaflix genre ids are TMDB's (e.g. 27 = Terror); names in pt-BR. No TMDB key involved. */
private val MOVIE_GENRES = linkedMapOf(
    "Ação" to 28, "Aventura" to 12, "Animação" to 16, "Comédia" to 35, "Crime" to 80, "Documentário" to 99,
    "Drama" to 18, "Família" to 10751, "Fantasia" to 14, "Ficção científica" to 878, "Guerra" to 10752,
    "História" to 36, "Mistério" to 9648, "Música" to 10402, "Romance" to 10749, "Suspense" to 53,
    "Terror" to 27, "Faroeste" to 37,
)
private val SERIES_GENRES = linkedMapOf(
    "Ação e Aventura" to 10759, "Animação" to 16, "Comédia" to 35, "Crime" to 80, "Documentário" to 99,
    "Drama" to 18, "Família" to 10751, "Kids" to 10762, "Mistério" to 9648, "Reality" to 10764,
    "Ficção científica e Fantasia" to 10765, "Guerra e Política" to 10768, "Faroeste" to 37,
)

private fun genres(type: String): Map<String, Int> = if (type == "movie") MOVIE_GENRES else SERIES_GENRES

private fun yearOptions(): List<String> {
    val current = kotlin.time.Clock.System.now().toString().take(4).toIntOrNull() ?: 2026
    return (current downTo 1970).map { it.toString() }
}
