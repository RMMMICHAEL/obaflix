package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.streams.StreamItem

/**
 * Obaflix servers ("Fontes Nativas") ride Nuvio's existing media-server path: listed as one more
 * server group, resolved only when chosen (`ServerPlayback.prepare`), never cached for reuse.
 * The Android implementation uses the official extractor on the device; no media goes through Vercel.
 */
internal interface ObaflixNativeSourceProvider {
    /** Opens an authorized source session and lists usable servers, unresolved. */
    suspend fun list(ref: ObaflixRef): List<StreamItem>

    /** Resolves one server into a playable URL (server-resolved or extracted on the device). */
    suspend fun prepare(stream: StreamItem): StreamItem
}

object ObaflixNative {
    const val CONNECTION_ID = "obaflix-native"
    const val GROUP_ID = "server:$CONNECTION_ID"
    const val LABEL = "Fontes Nativas"

    /** Registered by the Android application; null on platforms without the extractor. */
    internal var provider: ObaflixNativeSourceProvider? = null

    fun isNative(stream: StreamItem): Boolean = stream.serverTarget?.item?.connectionId == CONNECTION_ID
}
