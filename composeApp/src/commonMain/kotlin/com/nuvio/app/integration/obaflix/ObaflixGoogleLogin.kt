package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.launch

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

    /** What the native account picker answered. Only a token is ever sent to the server; it never decides identity by itself. */
    sealed interface NativeResult {
        class Token(val idToken: String) : NativeResult
        /** No Google account/credential support/client setup: the browser handoff takes over. */
        data object Unavailable : NativeResult
        /** The user dismissed the picker: nothing else opens. */
        data object Cancelled : NativeResult
    }

    /** Set by the Android host: shows the account picker; `nonce` is the PKCE challenge, so the token belongs to this attempt only. */
    internal var nativeIdToken: (suspend (nonce: String) -> NativeResult)? = null

    /** Network seam, replaced in tests. Returns (status, body). */
    internal var postNative: suspend (String) -> Pair<Int, String> = { body ->
        ObaflixSession.postPublic("/api/desktop-auth/google-native", body)
    }

    sealed interface NativeAttempt {
        class Ticket(val ticket: String, val verifier: String) : NativeAttempt
        data object Fallback : NativeAttempt
        data object Cancelled : NativeAttempt
        /** The server understood the token and refused this Google account (never fall back to a path that would bypass it). */
        data object Refused : NativeAttempt
    }

    /** Native sign-in step: token from the picker -> backend validates it and answers a handoff ticket (no session yet). */
    suspend fun signInNative(): NativeAttempt {
        val picker = nativeIdToken ?: return NativeAttempt.Fallback
        val pkce = newPkce?.invoke() ?: return NativeAttempt.Fallback
        val token = when (val r = picker(pkce.challenge)) {
            is NativeResult.Token -> r.idToken
            NativeResult.Cancelled -> return NativeAttempt.Cancelled
            NativeResult.Unavailable -> return NativeAttempt.Fallback
        }
        val (status, body) = try {
            postNative(
                kotlinx.serialization.json.buildJsonObject {
                    put("idToken", kotlinx.serialization.json.JsonPrimitive(token))
                    put("challenge", kotlinx.serialization.json.JsonPrimitive(pkce.challenge))
                    put("state", kotlinx.serialization.json.JsonPrimitive(pkce.state))
                }.toString(),
            )
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            return NativeAttempt.Fallback
        }
        if (status == 403) return NativeAttempt.Refused
        if (status != 200) return NativeAttempt.Fallback
        val ticket = runCatching {
            (kotlinx.serialization.json.Json.parseToJsonElement(body) as kotlinx.serialization.json.JsonObject)["ticket"]
                ?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.content }
        }.getOrNull()
        return if (ticket != null && TOKEN.matches(ticket)) NativeAttempt.Ticket(ticket, pkce.verifier) else NativeAttempt.Fallback
    }

    private val uiScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default)

    /** The "Entrar com Google" button: native picker first, the browser handoff when it is not available. [onFailure] gets a user message. */
    fun begin(onFailure: (String) -> Unit) {
        uiScope.launch {
            when (val attempt = signInNative()) {
                is NativeAttempt.Ticket -> com.nuvio.app.core.auth.AuthRepository.signInWithGoogleTicket(attempt.ticket, attempt.verifier)
                NativeAttempt.Cancelled -> Unit
                NativeAttempt.Refused -> onFailure("Esta conta Google não pode entrar. Use e-mail e senha ou outra conta.")
                NativeAttempt.Fallback -> if (!start()) onFailure("Não foi possível abrir o navegador para o login com Google.")
            }
        }
    }

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
