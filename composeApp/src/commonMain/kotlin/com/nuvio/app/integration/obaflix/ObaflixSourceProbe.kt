package com.nuvio.app.integration.obaflix

/**
 * Proves a source is really reachable before an action (cast / download) is committed to it: status, media content type
 * and no https -> http downgrade on redirects. The extension and the protocol alone are never proof.
 * Set by the Android application; null where nothing can be probed (tests, other platforms): the source is then trusted
 * as ranked, exactly like before.
 */
internal object ObaflixSourceProbe {
    internal var check: (suspend (url: String, headers: Map<String, String>) -> Boolean)? = null

    suspend fun reachable(url: String, headers: Map<String, String> = emptyMap()): Boolean =
        check?.let { runCatching { it(url, headers) }.getOrDefault(false) } ?: true
}
