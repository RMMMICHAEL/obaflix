package com.nuvio.app.integration.obaflix

import co.touchlab.kermit.Logger
import com.nuvio.app.features.library.LibraryItem
import com.nuvio.app.features.library.LibraryRepository
import com.nuvio.app.features.profiles.ProfileRepository
import com.nuvio.app.features.watchprogress.WatchProgressEntry
import com.nuvio.app.features.watchprogress.WatchProgressRepository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.time.Clock
import kotlin.time.Instant

/**
 * Brings the account's server-side "Minha Lista", history and "Continuar assistindo" (the data of the old WebView app)
 * into the native app, read-only: `GET /api/user/watchlist`, `/api/user/history`, `/api/continuar-assistindo`.
 *
 * Additive and idempotent by construction: nothing is ever deleted (locally or on the server); a progress entry is applied
 * only when it is newer than the local one ([WatchProgressRepository.applyExternalProgress]) and a title already in
 * "Minha Lista" is skipped. Bound to the signed-in account and the profile active when it started: if either changes,
 * it stops before writing. A run counts as complete only when every endpoint answered 200, every item was valid and no
 * answer hit the server's own cap (history 20, continue 24 — those endpoints have no pagination, so a capped answer may be
 * partial); otherwise it runs again at the next launch, harmlessly.
 */
internal object ObaflixDataImport {
    private val log = Logger.withTag("ObaflixImport")
    private val json = Json { ignoreUnknownKeys = true }

    internal const val HISTORY_CAP = 20
    internal const val CONTINUE_CAP = 24

    data class Outcome(val complete: Boolean, val progressApplied: Int, val librarySaved: Int, val skippedInvalid: Int)

    /** Network seam, replaced in tests. Returns (status, body). */
    internal var get: suspend (String) -> Pair<Int, String> = { path ->
        ObaflixSession.authedRequest("GET", path).let { it.status to it.body }
    }
    internal var applyProgress: (List<WatchProgressEntry>) -> Unit = { WatchProgressRepository.applyExternalProgress(it) }
    internal var isSaved: (String, String) -> Boolean = { id, type -> LibraryRepository.isSaved(id, type) }
    internal var save: (LibraryItem) -> Unit = { LibraryRepository.save(it) }
    internal var activeProfile: () -> Int = { ProfileRepository.activeProfileId }
    internal var currentUser: () -> String? = { ObaflixSession.user?.userId }
    internal var now: () -> Long = { Clock.System.now().toEpochMilliseconds() }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var job: Job? = null

    @kotlin.concurrent.Volatile
    private var completeFor: String? = null

    /** Starts the import for [userId] unless it already completed in this process or one is running for that account. */
    fun schedule(userId: String) {
        if (completeFor == userId) return
        job?.cancel()
        job = scope.launch {
            try {
                val outcome = run(userId)
                if (outcome.complete) completeFor = userId
                log.i { "importacao concluida=${outcome.complete} progresso=${outcome.progressApplied} lista=${outcome.librarySaved} invalidos=${outcome.skippedInvalid}" }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log.w { "importacao interrompida: ${e::class.simpleName}" }
            }
        }
    }

    internal fun reset() {
        job?.cancel()
        completeFor = null
    }

    suspend fun run(userId: String): Outcome {
        val profile = activeProfile()
        fun stillTheSame() = currentUser() == userId && activeProfile() == profile

        var complete = true
        var invalid = 0

        val watchlist = fetch("/api/user/watchlist")
        val history = fetch("/api/user/history")
        val resume = fetch("/api/continuar-assistindo")
        if (watchlist == null || history == null || resume == null) complete = false
        if ((history?.size ?: 0) >= HISTORY_CAP || (resume?.size ?: 0) >= CONTINUE_CAP) complete = false // may be a partial answer
        if (!stillTheSame()) return Outcome(false, 0, 0, 0)

        // Library: oldest first, so the newest keeps the most recent "saved at" and the server order is preserved.
        var saved = 0
        val library = watchlist.orEmpty().mapNotNull { row ->
            parseLibraryItem(row) ?: run { invalid++; null }
        }.reversed()
        for (item in library) {
            if (!stillTheSame()) return Outcome(false, 0, saved, invalid)
            if (isSaved(item.id, item.type)) continue
            save(item)
            saved++
        }

        // Progress: history rows carry the real `updatedAt`; "continue" rows only add titles history lacks.
        val entries = LinkedHashMap<String, WatchProgressEntry>()
        history.orEmpty().forEach { row ->
            val entry = parseProgress(row, fallbackUpdatedAt = null) ?: run { invalid++; null }
            if (entry != null) entries.putIfAbsent(entry.videoId, entry)
        }
        val oldestHistory = entries.values.minOfOrNull { it.lastUpdatedEpochMs } ?: now()
        resume.orEmpty().forEachIndexed { index, row ->
            // No timestamp in this endpoint: place them just below the oldest real one, in the server's order.
            val entry = parseProgress(row, fallbackUpdatedAt = oldestHistory - (index + 1) * 1_000L) ?: run { invalid++; null }
            if (entry != null) entries.putIfAbsent(entry.videoId, entry)
        }
        if (!stillTheSame()) return Outcome(false, 0, saved, invalid)
        if (entries.isNotEmpty()) applyProgress(entries.values.toList())

        if (invalid > 0) complete = false
        return Outcome(complete, entries.size, saved, invalid)
    }

    /** Null on any failure (status, transport, shape): the caller then does not count the run as complete. */
    private suspend fun fetch(path: String): List<JsonObject>? = try {
        val (status, body) = get(path)
        if (status != 200) null else json.parseToJsonElement(body).jsonArray.mapNotNull { it as? JsonObject }
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    private val SAFE_ID = Regex("^[A-Za-z0-9_-]{1,64}$")

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonElement)?.takeIf { it !is kotlinx.serialization.json.JsonNull }
        ?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }

    /** "filme" stays; anime/desenho/serie are all Obaflix series. */
    private fun native(tipo: String?): Pair<String, String>? = when (tipo) {
        null -> null
        "filme" -> "filme" to "movie"
        else -> "serie" to "series"
    }

    internal fun parseLibraryItem(row: JsonObject): LibraryItem? {
        val id = row.text("conteudoId")?.takeIf { SAFE_ID.matches(it) } ?: return null
        val (tipo, type) = native(row.text("conteudoTipo")) ?: return null
        val media = (row["filme"] as? JsonObject) ?: (row["serie"] as? JsonObject) ?: return null
        val title = media.text("titulo") ?: return null
        return LibraryItem(
            id = "obaflix:$tipo:$id",
            type = type,
            name = title,
            poster = media.text("poster"),
            banner = media.text("background"),
            logo = media.text("logo"),
            releaseInfo = media["ano"]?.jsonPrimitive?.contentOrNull,
            savedAtEpochMs = 0L, // LibraryRepository.save stamps the real time
        )
    }

    /** Works for both `/api/user/history` rows (nested media) and `/api/continuar-assistindo` rows (flat). */
    internal fun parseProgress(row: JsonObject, fallbackUpdatedAt: Long?): WatchProgressEntry? {
        val flat = row.text("titulo") != null
        val id = (if (flat) row.text("id") else row.text("conteudoId"))?.takeIf { SAFE_ID.matches(it) } ?: return null
        val (tipo, type) = native(if (flat) row.text("tipo") else row.text("conteudoTipo")) ?: return null
        val media = if (flat) row else (row["filme"] as? JsonObject) ?: (row["serie"] as? JsonObject) ?: return null
        val title = media.text("titulo") ?: return null
        val seconds = row["progressoSeg"]?.jsonPrimitive?.intOrNull ?: return null
        if (seconds < 0) return null
        val durationSeconds = row["duracaoSeg"]?.jsonPrimitive?.intOrNull?.takeIf { it > 0 }
        val season = row["temporada"]?.jsonPrimitive?.intOrNull
        val episode = row["numeroEp"]?.jsonPrimitive?.intOrNull
        val parent = "obaflix:$tipo:$id"
        val isEpisode = tipo == "serie" && season != null && episode != null && season >= 0 && episode >= 0
        val updated = row.text("updatedAt")?.let { runCatching { Instant.parse(it).toEpochMilliseconds() }.getOrNull() }
            ?: fallbackUpdatedAt ?: return null
        val position = seconds * 1_000L
        val duration = (durationSeconds ?: 0) * 1_000L
        return WatchProgressEntry(
            contentType = type,
            parentMetaId = parent,
            parentMetaType = type,
            videoId = if (isEpisode) "$parent:$season:$episode" else parent,
            title = title,
            logo = media.text("logo"),
            poster = media.text("poster"),
            background = media.text("background"),
            seasonNumber = if (isEpisode) season else null,
            episodeNumber = if (isEpisode) episode else null,
            lastPositionMs = position,
            durationMs = duration,
            lastUpdatedEpochMs = updated,
            isCompleted = false,
            progressPercent = if (duration > 0) (position * 100f / duration).coerceIn(0f, 100f) else null,
        )
    }
}
