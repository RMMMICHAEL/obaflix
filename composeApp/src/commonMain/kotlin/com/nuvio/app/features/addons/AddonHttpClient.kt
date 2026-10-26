package com.nuvio.app.features.addons

import com.nuvio.app.integration.obaflix.ObaflixCatalogAddon
import com.nuvio.app.integration.obaflix.ObaflixPlaybackGate

internal suspend fun fetchAddonResponseText(
    url: String,
    forceRefresh: Boolean = false,
): String {
    // Obaflix fork: the built-in catalog addon answers in-process (see ObaflixCatalogAddon).
    if (ObaflixCatalogAddon.handles(url)) return ObaflixCatalogAddon.respond(url)
    // Single choke point for every addon read: Obaflix content needs backend authorization first.
    val target = ObaflixPlaybackGate.rewriteAddonUrl(url)
    return if (forceRefresh) {
        httpGetTextWithHeaders(
            url = target,
            headers = mapOf("Cache-Control" to "no-cache"),
        )
    } else {
        httpGetText(target)
    }
}
