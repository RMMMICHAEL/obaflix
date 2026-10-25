package com.nuvio.app.integration.obaflix

/** Obaflix backend wiring for the native lab build. The backend stays the authority for users, rights and catalog. */
object ObaflixConfig {
    // Canonical origin: the backend's own NEXTAUTH_URL (callback-url cookie) is obaflixbr.com.
    const val PRODUCTION_BASE_URL = "https://obaflixbr.com"
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
     * Origin of the PUBLIC catalog (Home, lists, details, search): always the official site, plain read-only GETs without
     * cookies. A Preview pin moves login, rights, ads, sources and personal data, never the catalog.
     */
    const val CATALOG_BASE_URL = PRODUCTION_BASE_URL

    /** The session origin differs from the catalog's (Preview): ids of personal rows would not resolve in the catalog. */
    val catalogoSeparado: Boolean get() = CATALOG_BASE_URL != BASE_URL

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
            host != "obaflixbr.com" && !host.endsWith(".obaflixbr.com") && !host.contains("obaflix.online")
        if (valida) previewUrl = limpa
        return valida
    }

    /** Test seam: back to production defaults. */
    internal fun restaurarProducao() {
        previewUrl = null
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
