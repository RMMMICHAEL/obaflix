package com.nuvio.app.integration.obaflix

import co.touchlab.kermit.Logger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.time.Clock

/** Why an official host did not answer. Only these move the catalog to another host; HTTP/authorization errors never do. */
internal enum class HostFailure { DNS, TIMEOUT, TLS, CONNECT, INVALID_BODY }

/**
 * Public-catalog GET with automatic fallback among the official domains. Switches host only after a proven connection
 * failure (DNS, connect, TLS, timeout) or a 200 that is not JSON (an operator block page); an HTTP status error or an
 * empty result is the server speaking and is returned as is. The working host is remembered, so there is one request per
 * call in the normal case. Logs host and failure category only.
 */
internal object ObaflixHostFallback {
    private val log = Logger.withTag("ObaflixHost")

    internal var attemptTimeoutMs = 10_000L
    internal var clock: () -> Long = { Clock.System.now().toEpochMilliseconds() }

    suspend fun get(path: String, fetch: suspend (String) -> String): String {
        val origins = ObaflixConfig.catalogOrigins(clock())
        var last: Throwable? = null
        for (origin in origins) {
            val host = origin.removePrefix("https://")
            val outcome = try {
                val text = withTimeoutOrNull(attemptTimeoutMs) { fetch(origin + path) }
                when {
                    text == null -> Result.failure(HostFailureException(HostFailure.TIMEOUT))
                    !text.trimStart().let { it.startsWith("{") || it.startsWith("[") } ->
                        Result.failure(HostFailureException(HostFailure.INVALID_BODY))
                    else -> Result.success(text)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val category = classify(e) ?: throw e // HTTP error / empty body: the host answered, do not switch
                Result.failure(HostFailureException(category, e))
            }
            outcome.onSuccess {
                if (origin != origins.first() || origin != ObaflixConfig.CATALOG_BASE_URL) {
                    log.i { "catalogo host=$host resultado=ok (host em uso)" }
                }
                ObaflixConfig.rememberCatalogOrigin(origin, clock())
                return it
            }
            val failure = outcome.exceptionOrNull() as HostFailureException
            log.w { "catalogo host=$host falha=${failure.category.name.lowercase()}" }
            last = failure.cause ?: failure
        }
        throw last ?: IllegalStateException("catalogo indisponivel")
    }

    class HostFailureException(val category: HostFailure, cause: Throwable? = null) : Exception(category.name, cause)

    /** Connection-level exceptions only. `IllegalStateException` is how the HTTP layer reports a bad status / empty body. */
    internal fun classify(e: Throwable): HostFailure? {
        if (e is IllegalStateException) return null
        return when (e::class.simpleName.orEmpty()) {
            "UnknownHostException", "UnresolvedAddressException" -> HostFailure.DNS
            "SocketTimeoutException", "ConnectTimeoutException", "HttpRequestTimeoutException", "InterruptedIOException" -> HostFailure.TIMEOUT
            "SSLHandshakeException", "SSLPeerUnverifiedException", "SSLException", "CertificateException" -> HostFailure.TLS
            "ConnectException", "NoRouteToHostException", "SocketException", "EOFException", "IOException" -> HostFailure.CONNECT
            else -> null
        }
    }
}
