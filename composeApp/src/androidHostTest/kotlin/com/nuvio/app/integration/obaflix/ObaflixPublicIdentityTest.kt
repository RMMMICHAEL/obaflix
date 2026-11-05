package com.nuvio.app.integration.obaflix

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Public identity is Obaflix: no screen or string names Nuvio. The legally required notices stay in the repository files. */
class ObaflixPublicIdentityTest {
    private val resources = File("src/commonMain/composeResources")

    @Test
    fun visibleStringsSayObaflixInEveryLanguage() {
        val files = resources.listFiles { f -> f.name.startsWith("values") }!!.map { File(it, "strings.xml") }.filter(File::isFile)
        assertTrue(files.size > 20, "string files not found from ${File(".").absolutePath}")
        val leftovers = files.flatMap { file ->
            file.readLines().filter { "Nuvio" in it }.map { "${file.parentFile.name}: ${it.trim()}" }
        }
        assertEquals(emptyList(), leftovers)
    }

    @Test
    fun licenseNoticesStayInTheRepositoryNotInTheInterface() {
        val text = resources.listFiles { f -> f.name.startsWith("values") }!!.map { File(it, "strings.xml") }.filter(File::isFile)
            .joinToString(separator = "") { it.readText() }
        assertTrue("licenses_attributions" !in text && "Nuvio Mobile" !in text)
        val license = File("../LICENSE").readText()
        assertTrue(license.trimStart().startsWith("GNU GENERAL PUBLIC LICENSE") && "Version 3, 29 June 2007" in license)
    }

    @Test
    fun noClaimsAboutDisabledServicesOrNuvioOnlyFeatures() {
        val all = resources.listFiles { f -> f.name.startsWith("values") }!!.map { File(it, "strings.xml") }.filter(File::isFile)
        val text = all.joinToString(separator = "") { it.readText() }
        assertTrue("Obaflix Sync" !in text)
        assertTrue("Obaflix web panel" !in text && "painel web do Obaflix" !in text)
        val pt = File(resources, "values-pt-rBR/strings.xml").readText()
        val en = File(resources, "values/strings.xml").readText()
        for (claim in listOf("O Obaflix conecta-se ao", "O Obaflix se conecta ao", "Não Comerciais do IMDb", "Apoiador do Obaflix", "Apoiar o Obaflix")) assertTrue(claim !in pt, claim)
        for (claim in listOf("Obaflix connects to", "Non-Commercial Datasets", "Obaflix Supporter", "Support Obaflix")) assertTrue(claim !in en, claim)
    }
}
