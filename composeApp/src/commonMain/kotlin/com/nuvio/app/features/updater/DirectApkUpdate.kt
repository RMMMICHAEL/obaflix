package com.nuvio.app.features.updater

import io.ktor.http.Url
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

internal object DirectApkUpdateConfig {
    // Unset until the real Android manifest endpoint is confirmed. APK links are not manifests.
    const val stableManifestUrl = "https://app.obaflix.online/update-manifest.json" // same manifest the legacy WebView app reads
    const val betaManifestUrl = ""
    val allowedHosts = setOf("app.obaflix.online")
    const val checkIntervalMillis = 4 * 60 * 60 * 1_000L

    fun manifestUrl(channel: UpdateChannel): String = when (channel) {
        UpdateChannel.STABLE -> stableManifestUrl
        UpdateChannel.BETA -> betaManifestUrl
    }
}

internal data class DirectApkUpdate(
    val versionName: String,
    val versionCode: Long,
    val url: String,
    val size: Long,
    val sha256: String,
    val notes: String,
) {
    fun presentation() = AppUpdate(
        tag = versionName, title = "Obaflix $versionName", notes = notes, releaseUrl = null,
        assetName = "obaflix-update.apk", assetUrl = url, assetSizeBytes = size, versionCode = versionCode,
    )
}

internal fun isTrustedUpdateUrl(value: String, manifest: Boolean = false): Boolean = runCatching {
    val url = Url(value)
    value.startsWith("https://") && url.protocol.name == "https" &&
        url.host.lowercase() in DirectApkUpdateConfig.allowedHosts && url.port == 443 &&
        url.user == null && url.password == null && url.fragment.isEmpty() &&
        (!manifest || !url.encodedPath.lowercase().let { it.endsWith(".apk") || it.endsWith(".aab") })
}.getOrDefault(false)

internal fun parseDirectApkManifest(text: String): DirectApkUpdate? {
    val root = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull()
        ?: throw IllegalArgumentException("Manifesto de atualização inválido")
    fun JsonObject.number(key: String): Long? = (get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
    fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    require(root.number("schemaVersion") == 1L) { "Versão do manifesto não suportada" }
    val entry = root["android"] ?: return null
    require(entry is JsonObject) { "Entrada Android inválida" }
    val name = entry.text("versionName")?.trim().orEmpty()
    val code = entry.number("versionCode") ?: 0
    val url = entry.text("url").orEmpty()
    val size = entry.number("size") ?: 0
    val hash = entry.text("sha256").orEmpty().lowercase()
    require(name.isNotEmpty() && code in 1..Int.MAX_VALUE.toLong()) { "Versão Android inválida" }
    require(isTrustedUpdateUrl(url)) { "URL de atualização não autorizada" }
    require(size in 1..(2L * 1024 * 1024 * 1024)) { "Tamanho da atualização inválido" }
    require(hash.matches(Regex("[0-9a-f]{64}"))) { "SHA256 da atualização inválido" }
    return DirectApkUpdate(name, code, url, size, hash, entry.text("notes").orEmpty())
}

internal fun shouldCheckDirectUpdate(now: Long, lastCheck: Long): Boolean =
    lastCheck <= 0 || now < lastCheck || now - lastCheck >= DirectApkUpdateConfig.checkIntervalMillis
