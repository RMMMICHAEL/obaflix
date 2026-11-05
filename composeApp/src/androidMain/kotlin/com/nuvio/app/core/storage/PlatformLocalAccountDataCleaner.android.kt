package com.nuvio.app.core.storage

import android.content.Context

internal actual object PlatformLocalAccountDataCleaner {
    private val preferenceNames = listOf(
        "episode_shuffle",
        "nuvio_addons",
        "nuvio_library",
        "nuvio_library_display_settings",
        "nuvio_home_catalog_settings",
        "nuvio_player_settings",
        "torrent_settings",
        // Obaflix: nuvio_profile_cache is kept on logout; it is scoped to one user id (ProfileRepository.ensureLoaded).
        "nuvio_avatar_cache",
        "nuvio_profile_pin_cache",
        "nuvio_theme_settings",
        "nuvio_poster_card_style",
        "nuvio_debrid_settings",
        "nuvio_mdblist_settings",
        "nuvio_mdblist_auth",
        "nuvio_mdblist_sync",
        "nuvio_auth",
        "nuvio_trakt_auth",
        "nuvio_simkl_auth",
        "nuvio_simkl_sync",
        "nuvio_trakt_library",
        "nuvio_trakt_settings",
        "nuvio_watched",
        "nuvio_stream_link_cache",
        "nuvio_stream_badge_settings",
        "nuvio_continue_watching_preferences",
        "nuvio_cw_enrichment",
        "nuvio_episode_release_notifications",
        "nuvio_episode_release_notifications_platform",
        "nuvio_watch_progress",
        "nuvio_discover_selection",
        "nuvio_collection_mobile_settings",
        "nuvio_collections",
        "nuvio_plugins",
        "nuvio_member_access",
    )

    private var appContext: Context? = null

    fun initialize(context: Context) {
        appContext = context.applicationContext
    }

    private val userDataPreferenceNames = listOf("nuvio_watch_progress", "nuvio_library", "nuvio_watched")

    actual fun hasUserData(): Boolean {
        val context = appContext ?: return false
        return userDataPreferenceNames.any {
            context.getSharedPreferences(it, Context.MODE_PRIVATE).all.isNotEmpty()
        }
    }

    /**
     * Backup of data whose owner is unproven. Bounded and never lossy: an identical copy is not
     * stored twice, and at [MAX_QUARANTINE_SNAPSHOTS] distinct copies this throws instead of
     * dropping one, so the caller aborts before any destructive cleanup.
     */
    actual fun quarantine() {
        val context = appContext ?: error("storage not initialized")
        val current = userDataPreferenceNames.flatMap { name ->
            context.getSharedPreferences(name, Context.MODE_PRIVATE).all.map { (key, value) -> "$name|$key" to value }
        }.toMap()
        if (current.isEmpty()) return
        val store = context.getSharedPreferences("obaflix_quarantine", Context.MODE_PRIVATE)
        val byStamp = store.all.entries.groupBy({ it.key.substringBefore('|') }, { it.key.substringAfter('|') to it.value })
        if (byStamp.values.any { it.toMap() == current }) return
        check(byStamp.size < MAX_QUARANTINE_SNAPSHOTS) {
            "Há dados locais de origem desconhecida e o limite de cópias de segurança foi atingido. Nada foi apagado; contate o suporte antes de entrar com outra conta."
        }
        val edit = store.edit()
        val stamp = System.currentTimeMillis().toString()
        current.forEach { (k, value) ->
            val to = "$stamp|$k"
            when (value) {
                is String -> edit.putString(to, value)
                is Boolean -> edit.putBoolean(to, value)
                is Int -> edit.putInt(to, value)
                is Long -> edit.putLong(to, value)
                is Float -> edit.putFloat(to, value)
                is Set<*> -> edit.putStringSet(to, value.filterIsInstance<String>().toSet())
            }
        }
        check(edit.commit()) { "quarantine failed" }
    }

    internal const val MAX_QUARANTINE_SNAPSHOTS = 5

    actual fun wipe() {
        val context = appContext ?: return
        preferenceNames.forEach { name ->
            context.getSharedPreferences(name, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .apply()
        }
        context.filesDir.resolve("nuvio_plugin_scrapers").deleteRecursively()
    }
}
