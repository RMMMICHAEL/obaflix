package com.nuvio.app.integration.obaflix

/** Obaflix backend wiring for the native lab build. The backend stays the authority for users, rights and catalog. */
object ObaflixConfig {
    // Main origin of the app: obaflix.vercel.app (owner's decision: obaflixbr.com and obaflix.online failed on some operators).
    // NextAuth answers there like on the custom domains (CSRF, cookies, session); its own NEXTAUTH_URL still says obaflixbr.com
    // inside response bodies, which the client never follows.
    /** Public OAuth client id (Web type) of the Obaflix Google project: the `aud` the backend requires in a native ID token. */
    const val GOOGLE_WEB_CLIENT_ID = "693869418111-1070ghhc2vuso1kndr4dulgdr175ba94.apps.googleusercontent.com"

    const val PRODUCTION_BASE_URL = "https://obaflix.vercel.app"
    /** Distinct from the published WebView app ("android") so the server can enforce ads per app (ANUNCIO_ANDROID_NATIVO_ATIVO). */
    const val PLATFORM = "android_nativo"
    const val CLIENT_HEADER = "android-nativo"

    /** Sent on every Obaflix call; the server only trusts "android_nativo" when body, header and this UA agree. */
    fun userAgent(): String =
        "ObaflixNative/${com.nuvio.app.core.build.AppVersionConfig.VERSION_NAME.ifBlank { "dev" }}"

    @kotlin.concurrent.Volatile
    private var previewUrl: String? = null

    /**
     * Where every request of this build goes. Production unless a DEBUG homologation build pinned a Preview origin with
     * [usarPreview]: then **all** traffic (login, catalog, authorize, ads) goes there and nothing falls back to production.
     */
    val BASE_URL: String get() = previewUrl ?: PRODUCTION_BASE_URL

    /**
     * The three official domains of the same Production project, in priority order. Verified equivalent for the public API
     * (identical `/api/billing/plans` JSON on all three). Only PUBLIC catalog GETs may fall back between them: login,
     * rights, ads and every cookie call stay on [PRODUCTION_BASE_URL] until a session is proven valid across hosts.
     */
    val OFFICIAL_ORIGINS = listOf(PRODUCTION_BASE_URL, "https://obaflixbr.com", "https://obaflix.online")

    @kotlin.concurrent.Volatile
    private var catalogOrigin: String = OFFICIAL_ORIGINS.first()

    @kotlin.concurrent.Volatile
    private var catalogSwitchedAtMs: Long = 0L

    /** How long a fallback host is kept before the preferred one is tried again (no three requests per navigation). */
    internal const val PRIMARY_RETRY_MS = 5 * 60_000L

    /**
     * Origin of the PUBLIC catalog (Home, lists, details, search): the remembered working official host, read-only GETs
     * without cookies. A Preview pin moves login, rights, ads, sources and personal data, never the catalog.
     */
    val CATALOG_BASE_URL: String get() = catalogOrigin

    /** Order to try the catalog hosts: the remembered one first; the preferred one first again after [PRIMARY_RETRY_MS]. */
    internal fun catalogOrigins(nowMs: Long): List<String> {
        val active = catalogOrigin
        if (active == OFFICIAL_ORIGINS.first() || nowMs - catalogSwitchedAtMs >= PRIMARY_RETRY_MS) return OFFICIAL_ORIGINS
        return listOf(active) + OFFICIAL_ORIGINS.filter { it != active }
    }

    internal fun rememberCatalogOrigin(origin: String, nowMs: Long) {
        if (origin == catalogOrigin) return
        catalogOrigin = origin
        catalogSwitchedAtMs = nowMs
    }

    /** The session origin differs from the catalog's: only when a Preview is pinned (ids of personal rows would not resolve). */
    val catalogoSeparado: Boolean get() = previewUrl != null

    /** True only when a Preview origin is pinned. The S2S Rewarded requires it. */
    val usandoPreview: Boolean get() = previewUrl != null

    /**
     * Pins a Vercel Preview origin (`https://<name>.vercel.app`, no path). Anything else — http, another domain, a path,
     * or the production hosts — is refused and leaves the build on production defaults. Called only by DEBUG builds.
     */
    fun usarPreview(url: String): Boolean {
        val limpa = url.trim().trimEnd('/')
        val host = limpa.removePrefix("https://")
        val valida = limpa.startsWith("https://") &&
            host.isNotEmpty() && '/' !in host && ':' !in host && '@' !in host && '?' !in host && '#' !in host &&
            host.endsWith(".vercel.app") && host.length > ".vercel.app".length &&
            host.all { it.isLowerCase() || it.isDigit() || it == '-' || it == '.' } &&
            host != "obaflix.vercel.app" && host != "obaflixbr.com" && !host.endsWith(".obaflixbr.com") && !host.contains("obaflix.online")
        if (valida) previewUrl = limpa
        return valida
    }

    /** Test seam: back to production defaults. */
    internal fun restaurarProducao() {
        previewUrl = null
        catalogOrigin = OFFICIAL_ORIGINS.first()
        catalogSwitchedAtMs = 0L
    }

    /**
     * Addon-protocol address of the Obaflix catalog. Served in-process by [ObaflixCatalogAddon]
     * until the backend exposes the same JSON at this path; the app needs no change when it does.
     */
    val CATALOG_ADDON_MANIFEST_URL: String get() = "$BASE_URL/api/nuvio-addon/manifest.json"

    /** Playback addons preinstalled on a fresh install only; removable like any other. */
    val DEFAULT_PLAYBACK_ADDON_URLS = listOf("https://fenixflix.fenixhub.online/manifest.json")

    /** Existing site pages: legal texts and the real account-deletion flow (no second system in the app). */
    val PRIVACY_URL: String get() = "$BASE_URL/privacidade"
    val TERMS_URL: String get() = "$BASE_URL/termos"
    val DELETE_ACCOUNT_URL: String get() = "$BASE_URL/excluir-conta"

    /** RFC 2606 reserved TLD: never resolves, so any leftover Nuvio cloud call fails like being offline. */
    const val DISABLED_NUVIO_BACKEND_URL = "https://nuvio-cloud.invalid"
}
