package com.nuvio.app.core.network

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Test
import org.w3c.dom.Element
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ObaflixNetworkSecurityConfigTest {
    private val root = File(System.getProperty("obaflix.test.root", ".."))
    private val configPath = "composeApp/src/androidMain/res/xml/network_security_config.xml"
    private val android = "http://schemas.android.com/apk/res/android"

    private fun xml(path: String): Element {
        val factory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        }
        return factory.newDocumentBuilder().parse(File(root, path)).documentElement
    }

    @Test fun onlyObaflixAndItsSubdomainsDenyCleartext() {
        val configs = xml(configPath).getElementsByTagName("domain-config")
        assertEquals(1, configs.length)
        val config = configs.item(0) as Element
        assertEquals("false", config.getAttribute("cleartextTrafficPermitted"))
        val domains = config.getElementsByTagName("domain")
        assertEquals(1, domains.length)
        val domain = domains.item(0) as Element
        assertEquals("obaflixbr.com", domain.textContent.trim())
        assertEquals("true", domain.getAttribute("includeSubdomains"))
        assertEquals(0, config.getElementsByTagName("trust-anchors").length)
    }

    @Test fun externalHttpAndGlobalTrustAnchorsRemainAvailable() {
        val configs = xml(configPath).getElementsByTagName("base-config")
        assertEquals(1, configs.length)
        val base = configs.item(0) as Element
        assertEquals("true", base.getAttribute("cleartextTrafficPermitted"))
        val anchors = base.getElementsByTagName("certificates")
        assertEquals(listOf("system", "@raw/isrg_root_x1", "@raw/isrg_root_x2"),
            (0 until anchors.length).map { (anchors.item(it) as Element).getAttribute("src") })
    }

    @Test fun applicationManifestSelectsConfigWithoutDisablingExternalHttp() {
        val manifest = xml("androidApp/src/main/AndroidManifest.xml")
        val app = manifest.getElementsByTagName("application").item(0) as Element
        assertEquals("@xml/network_security_config", app.getAttributeNS(android, "networkSecurityConfig"))
        assertEquals("true", app.getAttributeNS(android, "usesCleartextTraffic"))
        val versions = File(root, "gradle/libs.versions.toml").readText()
        val minSdk = Regex("android-minSdk = \"(\\d+)\"").find(versions)!!.groupValues[1].toInt()
        assertTrue(minSdk >= 24, "Domain network security config requires API 24")
        listOf("androidApp", "composeApp", "obaflix-core-extractor").forEach { module ->
            File(root, "$module/src").walkTopDown().filter { it.name == "AndroidManifest.xml" && it != File(root, "androidApp/src/main/AndroidManifest.xml") }.forEach { file ->
                val applications = xml(file.relativeTo(root).path).getElementsByTagName("application")
                for (i in 0 until applications.length) {
                    val other = applications.item(i) as Element
                    assertTrue(!other.hasAttributeNS(android, "networkSecurityConfig"), "Variant overrides config: $file")
                    assertTrue(!other.hasAttributeNS(android, "usesCleartextTraffic"), "Variant overrides HTTP policy: $file")
                }
            }
        }
        val configs = listOf("androidApp", "composeApp").flatMap { module ->
            File(root, "$module/src").walkTopDown().filter { it.name == "network_security_config.xml" }.toList()
        }
        assertEquals(listOf(File(root, configPath)), configs)
    }
}
