package com.nuvio.app.features.watching.sync

import com.nuvio.app.features.watched.WatchedItem

/** Obaflix keeps "watched" on the device only: no Nuvio cloud (Supabase) call, and a push never reports failure. */
object LocalOnlyWatchedSyncAdapter : WatchedSyncAdapter {
    override suspend fun pull(profileId: Int, pageSize: Int): List<WatchedItem> = emptyList()

    override suspend fun push(profileId: Int, items: Collection<WatchedItem>) = Unit

    override suspend fun delete(profileId: Int, items: Collection<WatchedItem>) = Unit
}
