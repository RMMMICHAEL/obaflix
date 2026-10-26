package com.nuvio.app.features.updater

import kotlinx.serialization.json.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DirectApkUpdateTest {
    private fun manifest(entry: String) = """{"schemaVersion":1,"android":$entry,"androidTv":{"ignored":true}}"""
    private fun entry() = """{"versionName":"1.0.0","versionCode":200,"url":"https://app.obaflix.online/test-only.apk","size":100,"sha256":"${"a".repeat(64)}"}"""

    @Test fun onlyTheExistingLegacyManifestIsConfigured() {
        assertEquals("https://app.obaflix.online/update-manifest.json", DirectApkUpdateConfig.manifestUrl(UpdateChannel.STABLE))
        assertEquals("", DirectApkUpdateConfig.manifestUrl(UpdateChannel.BETA))
        assertTrue(isTrustedUpdateUrl(DirectApkUpdateConfig.stableManifestUrl, manifest = true))
        assertFalse(isTrustedUpdateUrl("", manifest = true))
    }

    @Test fun parsesOnlyAndroidUsingExistingObaflixSchema() {
        val release = parseDirectApkManifest(manifest(entry()))!!
        assertEquals(200L, release.versionCode)
        assertEquals(100L, release.size)
        assertEquals("a".repeat(64), release.sha256)
        assertEquals("obaflix-update.apk", release.presentation().assetName)
        assertNull(release.presentation().releaseUrl)
        assertNull(parseDirectApkManifest("""{"schemaVersion":1,"androidTv":{"versionCode":1000}}"""))
    }

    @Test fun rejectsIncompleteOrMalformedMetadata() {
        val badFields = mapOf(
            "size" to listOf(null, JsonPrimitive(0), JsonPrimitive(2147483649L)),
            "versionCode" to listOf(JsonPrimitive(0), JsonPrimitive("200")),
            "sha256" to listOf(JsonPrimitive("not-a-hash")),
            "url" to listOf(JsonPrimitive("http://app.obaflix.online/a"), JsonPrimitive("https://example.invalid/a")),
        )
        badFields.forEach { (key, values) -> values.forEach { value ->
            val fields = Json.parseToJsonElement(entry()).jsonObject.toMutableMap()
            if (value == null) fields.remove(key) else fields[key] = value
            assertFailsWith<IllegalArgumentException> { parseDirectApkManifest(manifest(JsonObject(fields).toString())) }
        } }
        assertFailsWith<IllegalArgumentException> { parseDirectApkManifest("not JSON") }
        assertFailsWith<IllegalArgumentException> { parseDirectApkManifest("""{"schemaVersion":2}""") }
    }

    @Test fun httpsHostAndCredentialBoundariesAreStrict() {
        assertTrue(isTrustedUpdateUrl("https://app.obaflix.online/test-only.json", manifest = true))
        listOf("http://app.obaflix.online/a", "https://app.obaflix.online.evil.invalid/a",
            "https://user:password@app.obaflix.online/a", "https://app.obaflix.online/a#fragment",
            "https://app.obaflix.online:8443/a", "file:///tmp/a").forEach { assertFalse(isTrustedUpdateUrl(it)) }
        assertFalse(isTrustedUpdateUrl("https://app.obaflix.online/test-only.apk", manifest = true))
        assertFalse(isTrustedUpdateUrl("https://app.obaflix.online/test-only.aab", manifest = true))
    }

    @Test fun versionCodeTakesPrecedenceOverDisplayVersion() {
        val update = parseDirectApkManifest(manifest(entry()))!!.presentation()
        assertTrue(update.isNewerThan("99.0.0", 199))
        assertFalse(update.isNewerThan("0.0.1", 200))
        assertFalse(update.isNewerThan("0.0.1", 201))
        assertFalse(update.isNewerThan("0.0.1", null))
        assertFalse(update.copy(versionCode = null).isNewerThan("99.0.0", null))
    }

    @Test fun automaticResultsCannotOpenOrResizePlayerUi() {
        val update = parseDirectApkManifest(manifest(entry()))!!.presentation()
        assertFalse(update.shouldPrompt(force = false, ignored = false))
        assertFalse(update.shouldPrompt(force = false, ignored = true))
        assertTrue(update.shouldPrompt(force = true, ignored = true))
        assertTrue(update.copy(versionCode = null).shouldPrompt(force = false, ignored = false))
    }

    @Test fun checksAreThrottledAndClockRollbackCanRecover() {
        val interval = DirectApkUpdateConfig.checkIntervalMillis
        assertTrue(shouldCheckDirectUpdate(100, 0))
        assertFalse(shouldCheckDirectUpdate(100, 100))
        assertFalse(shouldCheckDirectUpdate(100 + interval - 1, 100))
        assertTrue(shouldCheckDirectUpdate(100 + interval, 100))
        assertTrue(shouldCheckDirectUpdate(50, 100))
    }
}
