package com.nuvio.app.integration.obaflix

import com.nuvio.app.core.auth.AuthRepository
import com.nuvio.app.features.watching.sync.ProgressSyncAdapter
import com.nuvio.app.features.watching.sync.ProgressSyncRecord
import com.nuvio.app.features.watchprogress.WatchProgressEntry
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Writes Nuvio watch progress into the Obaflix history (`POST /api/progress`), keyed by canonical
 * Obaflix ids. Titles from other sources (e.g. personal media servers) stay local.
 *
 * Disabled by default ([remoteSyncEnabled]): history lives only on the device, per profile and per
 * account, so playback costs the backend no requests. The code stays for a future cloud-sync phase.
 * shortcut: push-only; Obaflix history is not pulled back into the device.
 */
internal object ObaflixProgressSyncAdapter : ProgressSyncAdapter {
    /** Local-only history: no `POST /api/progress` unless a cloud-sync phase turns this on. */
    internal var remoteSyncEnabled = false

    /** Network seam, replaced in tests. Returns the HTTP status. */
    internal var post: suspend (String) -> Int = { body ->
        ObaflixSession.authedRequest("POST", "/api/progress", body).status
    }

    override suspend fun pull(profileId: Int, sinceLastWatched: Long?, limit: Int?): List<ProgressSyncRecord> = emptyList()

    override suspend fun push(profileId: Int, entries: Collection<WatchProgressEntry>) {
        if (!remoteSyncEnabled || ObaflixSession.user == null) return
        for (entry in entries) {
            val body = requestBody(entry) ?: continue
            val status = post(body)
            if (status == 401) {
                AuthRepository.onObaflixSessionRejected()
                return
            }
            // Fail loudly so Nuvio keeps its local state and logs, instead of recording a false success.
            check(status in 200..299) { "Obaflix progress rejected with HTTP $status" }
        }
    }

    /** Obaflix has no per-entry history delete endpoint; removal stays local. */
    override suspend fun delete(profileId: Int, entries: Collection<WatchProgressEntry>) = Unit

    internal suspend fun requestBody(entry: WatchProgressEntry): String? {
        val ref = ObaflixRef.parse(entry.videoId) ?: ObaflixRef.parse(entry.parentMetaId) ?: return null
        if (entry.durationMs <= 0) return null
        val season = ref.season ?: entry.seasonNumber
        val episode = ref.episode ?: entry.episodeNumber
        val episodeId = if (ref.tipo == "serie") {
            if (season == null || episode == null) return null
            ObaflixCatalogAddon.episodeId(ref.id, season, episode) ?: return null
        } else {
            null
        }
        return buildJsonObject {
            put("conteudoId", ref.id)
            put("conteudoTipo", ref.tipo)
            put("progressoSeg", entry.lastPositionMs.coerceAtLeast(0) / 1000)
            put("duracaoSeg", entry.durationMs / 1000)
            if (episodeId != null) {
                put("episodioId", episodeId)
                put("temporada", season)
                put("numeroEp", episode)
            }
        }.toString()
    }
}
