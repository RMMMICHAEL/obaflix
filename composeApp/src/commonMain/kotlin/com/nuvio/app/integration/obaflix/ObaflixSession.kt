package com.nuvio.app.integration.obaflix

import com.nuvio.app.core.auth.AuthStorage
import com.nuvio.app.features.addons.RawHttpResponse
import com.nuvio.app.features.addons.httpRequestRaw
import io.ktor.http.encodeURLParameter
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@Serializable
internal data class ObaflixStoredSession(
    val cookies: Map<String, String>,
    val userId: String,
    val email: String?,
)

/**
 * Obaflix login over the existing NextAuth credentials contract: the same session cookie the
 * site and the current mobile app use, accepted by `authSession.ts` as origin "cookie".
 * Cookies are only ever sent to [ObaflixConfig.BASE_URL].
 */
internal object ObaflixSession {
    private val json = Json { ignoreUnknownKeys = true }

    internal var current: ObaflixStoredSession? = null

    /** Network seam, replaced in tests. Never follows redirects, so cookies cannot leave [ObaflixConfig.BASE_URL]. */
    internal var http: suspend (method: String, url: String, headers: Map<String, String>, body: String) -> RawHttpResponse =
        { method, url, headers, body -> httpRequestRaw(method, url, headers, body, followRedirects = false) }

    val user: ObaflixStoredSession? get() = current

    fun restore(): ObaflixStoredSession? {
        val payload = AuthStorage.loadObaflixSession() ?: return null
        current = runCatching { json.decodeFromString<ObaflixStoredSession>(payload) }.getOrNull()
        if (current == null) AuthStorage.clearObaflixSession()
        return current
    }

    /** Returns null on success, or a user-facing reason. Never logs the password or cookies. */
    suspend fun signIn(email: String, password: String): String? = try {
        signInOrThrow(email, password)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        connectionFailureMessage(e)
    }

    private suspend fun signInOrThrow(email: String, password: String): String? {
        val jar = mutableMapOf<String, String>()
        val csrfResponse = request("GET", "/api/auth/csrf", jar)
        val csrf = runCatching {
            json.parseToJsonElement(csrfResponse.body).jsonObject["csrfToken"]?.jsonPrimitive?.content
        }.getOrNull() ?: return "Não foi possível conectar ao Obaflix."

        val form = listOf(
            "csrfToken" to csrf,
            "email" to email.trim(),
            "senha" to password,
            "json" to "true",
        ).joinToString("&") { (k, v) -> "$k=${v.encodeURLParameter()}" }
        request(
            "POST",
            "/api/auth/callback/credentials",
            jar,
            body = form,
            extraHeaders = mapOf("Content-Type" to "application/x-www-form-urlencoded"),
        )
        if (jar.keys.none(::isSessionCookie)) return "E-mail ou senha inválidos."

        val sessionUser = parseSessionUser(request("GET", "/api/auth/session", jar).body)
            ?: return "E-mail ou senha inválidos."
        val session = ObaflixStoredSession(jar.filterKeys(::isSessionCookie), sessionUser.first, sessionUser.second)
        ObaflixAdEligibility.reset() // account switch: never inherit the previous account's answer
        ObaflixRights.reset()
        current = session
        persist()
        return null
    }

    /**
     * Google handoff: trades the site's one-time ticket + PKCE verifier for a session created by [ObaflixConfig.BASE_URL]
     * itself, then reads the signed-in user from that same host. Null on success, or a user-facing reason.
     */
    suspend fun signInWithTicket(ticket: String, verifier: String): String? = try {
        val jar = mutableMapOf<String, String>()
        val form = listOf("ticket" to ticket, "verifier" to verifier).joinToString("&") { (k, v) -> "$k=${v.encodeURLParameter()}" }
        val exchange = request(
            "POST", "/api/desktop-auth/exchange", jar, body = form,
            extraHeaders = mapOf("Content-Type" to "application/x-www-form-urlencoded"),
        )
        if (exchange.status != 200 || jar.keys.none(::isSessionCookie)) {
            "Não foi possível concluir o login com Google. Tente novamente."
        } else {
            val sessionUser = parseSessionUser(request("GET", "/api/auth/session", jar).body)
            if (sessionUser == null) {
                "Não foi possível concluir o login com Google. Tente novamente."
            } else {
                ObaflixAdEligibility.reset()
                ObaflixRights.reset()
                current = ObaflixStoredSession(jar.filterKeys(::isSessionCookie), sessionUser.first, sessionUser.second)
                persist()
                null
            }
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        connectionFailureMessage(e)
    }

    fun persist() {
        val session = current ?: return
        AuthStorage.saveObaflixSession(json.encodeToString(ObaflixStoredSession.serializer(), session))
    }

    /** Local sign-out always succeeds; the JWT simply stops being sent. */
    fun signOut() {
        current = null
        ObaflixAdEligibility.reset()
        ObaflixRights.reset()
        ObaflixPlaybackGate.clear()
        AuthStorage.clearObaflixSession()
    }

    fun cookieHeader(): String? =
        current?.cookies?.entries?.joinToString("; ") { "${it.key}=${it.value}" }

    /** Authenticated call to the Obaflix API. Origin is required by the cookie routes' CSRF check. */
    suspend fun authedRequest(method: String, path: String, body: String = ""): RawHttpResponse {
        val cookie = cookieHeader() ?: error("Sem sessão Obaflix")
        return http(
            method,
            ObaflixConfig.BASE_URL + path,
            mapOf(
                "Cookie" to cookie,
                "Origin" to ObaflixConfig.BASE_URL,
                "Content-Type" to "application/json",
                "Accept" to "application/json",
                "User-Agent" to ObaflixConfig.userAgent(),
                "X-Obaflix-Client" to ObaflixConfig.CLIENT_HEADER,
            ),
            body,
        )
    }

    private suspend fun request(
        method: String,
        path: String,
        jar: MutableMap<String, String>,
        body: String = "",
        extraHeaders: Map<String, String> = emptyMap(),
    ): RawHttpResponse {
        val headers = buildMap {
            put("Accept", "application/json")
            put("Origin", ObaflixConfig.BASE_URL)
            put("User-Agent", ObaflixConfig.userAgent())
            put("X-Obaflix-Client", ObaflixConfig.CLIENT_HEADER)
            if (jar.isNotEmpty()) put("Cookie", jar.entries.joinToString("; ") { "${it.key}=${it.value}" })
            putAll(extraHeaders)
        }
        val response = http(method, ObaflixConfig.BASE_URL + path, headers, body)
        jar.putAll(parseSetCookies(response.headers["set-cookie"]))
        return response
    }
}

/**
 * Portuguese reason for a failed connection. A sinkhole answer (0.0.0.0 / ::) or an unknown host
 * means the device's DNS, VPN or network blocked the name: the app does not work around it.
 */
internal fun connectionFailureMessage(e: Throwable): String {
    val type = e::class.simpleName.orEmpty()
    val text = generateSequence(e) { it.cause }.joinToString(" ") { "${it::class.simpleName} ${it.message}" }
    return when {
        "/0.0.0.0" in text || "/127.0.0.1" in text || "/::" in text || "UnknownHost" in text ->
            "A rede ou o DNS do aparelho está bloqueando o Obaflix. Desative DNS privado, bloqueador ou VPN, ou troque de rede, e tente novamente."
        "SSL" in text || "Certificate" in text ->
            "Não foi possível estabelecer uma conexão segura com o Obaflix. Confira a data e a hora do aparelho e a rede."
        "Timeout" in type || "timeout" in text ->
            "O Obaflix demorou para responder. Tente novamente."
        else -> "Não foi possível conectar ao Obaflix. Verifique sua conexão."
    }
}

internal fun isSessionCookie(name: String): Boolean =
    name.endsWith("next-auth.session-token") || name.contains("next-auth.session-token.")

/** Splits an OkHttp-joined `set-cookie` header; commas inside `Expires=Wed, 21 Oct` are not separators. */
internal fun parseSetCookies(header: String?): Map<String, String> {
    if (header.isNullOrBlank()) return emptyMap()
    return header.split(Regex(""",(?=\s*[A-Za-z0-9_.\-]+=)"""))
        .mapNotNull { cookie ->
            val pair = cookie.substringBefore(';').trim()
            val name = pair.substringBefore('=', "").trim()
            val value = pair.substringAfter('=', "").trim()
            if (name.isEmpty()) null else name to value
        }
        .toMap()
        .filterValues { it.isNotEmpty() } // deletion cookies arrive with an empty value
}

/** `/api/auth/session` answers `{}` when signed out. Returns (userId, email). */
internal fun parseSessionUser(body: String): Pair<String, String?>? = runCatching {
    val user = Json.parseToJsonElement(body).jsonObject["user"]?.jsonObject ?: return null
    val email = user["email"]?.jsonPrimitive?.content
    val id = user["id"]?.jsonPrimitive?.content ?: email ?: return null
    id to email
}.getOrNull()
