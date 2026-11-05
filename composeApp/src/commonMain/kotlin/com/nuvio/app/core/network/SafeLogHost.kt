package com.nuvio.app.core.network

import io.ktor.http.Url

internal fun safeLogHost(rawUrl: String): String = runCatching {
    if (!rawUrl.contains("://")) return@runCatching null
    Url(rawUrl).host.takeIf { host ->
        host.isNotBlank() && host.all { char ->
            char in 'a'..'z' || char in 'A'..'Z' || char in '0'..'9' || char in ".-:[]"
        }
    }
}.getOrNull() ?: "<invalid-host>"
