package com.nuvio.app.features.updater

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class UpdaterDistributionBoundaryTest {
    private val root = File(System.getProperty("obaflix.test.root", ".."))
    private val android = "http://schemas.android.com/apk/res/android"
    private fun xml(file: File): Element = DocumentBuilderFactory.newInstance().apply {
        isNamespaceAware = true
        setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
    }.newDocumentBuilder().parse(file).documentElement

    @Test fun onlyDirectApkVariantsRequestPackageInstallation() {
        val owners = listOf("androidApp", "composeApp").flatMap { module ->
            File(root, "$module/src").walkTopDown().filter { it.name == "AndroidManifest.xml" }.filter { file ->
                val permissions = xml(file).getElementsByTagName("uses-permission")
                (0 until permissions.length).any {
                    (permissions.item(it) as Element).getAttributeNS(android, "name") == "android.permission.REQUEST_INSTALL_PACKAGES"
                }
            }.map { it.relativeTo(root).invariantSeparatorsPath }.toList()
        }.sorted()
        assertEquals(listOf("androidApp/src/full/AndroidManifest.xml", "composeApp/src/androidFull/AndroidManifest.xml"), owners)
    }

    @Test fun privateApkCacheIsCoveredByExistingFileProvider() {
        val paths = xml(File(root, "composeApp/src/androidMain/res/xml/file_paths.xml")).getElementsByTagName("cache-path")
        assertTrue((0 until paths.length).any { (paths.item(it) as Element).getAttribute("path") == "updates/" })
        val providers = xml(File(root, "androidApp/src/main/AndroidManifest.xml")).getElementsByTagName("provider")
        val provider = (0 until providers.length).map { providers.item(it) as Element }
            .single { it.getAttributeNS(android, "name") == "androidx.core.content.FileProvider" }
        assertEquals("false", provider.getAttributeNS(android, "exported"))
        assertEquals("true", provider.getAttributeNS(android, "grantUriPermissions"))
        val data = provider.getElementsByTagName("meta-data").item(0) as Element
        assertEquals("@xml/file_paths", data.getAttributeNS(android, "resource"))
    }

    @Test fun updaterIsEnabledOnlyInTheExternalVariantAndPlayStaysOff() {
        fun policy(variant: String) = File(root, "composeApp/src/$variant/kotlin/com/nuvio/app/core/build/AppFeaturePolicy.android.kt").readText()
        assertTrue(policy("androidFull").contains("actual val inAppUpdaterEnabled: Boolean = true"))
        assertTrue(policy("androidPlaystore").contains("actual val inAppUpdaterEnabled: Boolean = false"))
    }

    @Test fun externalUpdaterReadsTheLegacyManifestOnItsFixedHost() {
        val config = File(root, "composeApp/src/commonMain/kotlin/com/nuvio/app/features/updater/DirectApkUpdate.kt").readText()
        assertTrue(config.contains("https://app.obaflix.online/update-manifest.json"))
    }
}
