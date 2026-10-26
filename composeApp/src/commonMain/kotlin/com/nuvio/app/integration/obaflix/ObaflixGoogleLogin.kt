package com.nuvio.app.integration.obaflix

/**
 * "Entrar com Google" for accounts that have no password, through the site's existing desktop handoff (PKCE ticket):
 * the system browser signs in with Google on [ObaflixConfig.BASE_URL] (never obaflixbr.com), the site answers with
 * `obaflix://auth/callback?ticket&state`, and the app trades `ticket + verifier` for a session created by that same host.
 * No cookie crosses domains, the browser never holds the session and a stolen ticket is useless without the verifier.
 */
internal object ObaflixGoogleLogin {
    class Pkce(val verifier: String, val challenge: String, val state: String)

    /** Set by the Android host: secure random PKCE material (S256). */
    internal var newPkce: (() -> Pkce)? = null

    /** Set by the Android host: opens the URL in the system browser; false when there is none. */
    internal var openBrowser: ((String) -> Boolean)? = null

    private var pending: Pkce? = null

    const val CALLBACK_PREFIX = "obaflix://auth/callback"

    private val TOKEN = Regex("^[A-Za-z0-9_.-]{20,4096}$")

    val available: Boolean get() = newPkce != null && openBrowser != null

    /** Opens the login page of the main host. Replaces any request still pending. */
    fun start(): Boolean {
        val pkce = newPkce?.invoke() ?: return false
        pending = pkce
        val url = "${ObaflixConfig.BASE_URL}/desktop-auth?challenge=${pkce.challenge}&state=${pkce.state}&callbackUrl=%2Fdesktop"
        val opened = openBrowser?.invoke(url) == true
        if (!opened) pending = null
        return opened
    }

    fun isCallback(link: String): Boolean = link.startsWith(CALLBACK_PREFIX)

    /**
     * The (ticket, verifier) to exchange, only for the callback that answers the pending request (same `state`), once.
     * Any other link, a wrong state or a malformed ticket returns null and leaves nothing behind.
     */
    fun consume(link: String): Pair<String, String>? {
        val request = pending ?: return null
        if (!isCallback(link)) return null
        val query = link.substringAfter('?', "").substringBefore('#')
        val params = query.split('&').filter { it.contains('=') }.associate { it.substringBefore('=') to it.substringAfter('=') }
        val ticket = params["ticket"]
        if (params["state"] != request.state || ticket == null || !TOKEN.matches(ticket)) return null
        pending = null
        return ticket to request.verifier
    }

    internal fun reset() {
        pending = null
    }
}
