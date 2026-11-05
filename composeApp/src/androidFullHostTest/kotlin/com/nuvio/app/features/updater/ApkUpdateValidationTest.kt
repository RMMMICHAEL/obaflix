package com.nuvio.app.features.updater

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ApkUpdateValidationTest {
    private fun verify(installed: Set<String> = setOf("old"), archive: Set<String> = setOf("old"),
        archivePackage: String = "com.obaflix.test",
        installedCode: Long = 1, archiveCode: Long = 2, expectedCode: Long = 2) = verifyUpdateIdentity(
        "com.obaflix.test", archivePackage, installedCode, archiveCode, expectedCode, installed, archive,
    )

    @Test fun exactSignatureAndValidVersionAreAccepted() { verify() }
    @Test fun differentCurrentSigningKeyRequiresSeparateValidation() { assertFailsWith<IllegalArgumentException> { verify(archive = setOf("new")) } }
    @Test fun mismatchedAndMissingSignersAreRejected() {
        assertFailsWith<IllegalArgumentException> { verify(archive = setOf("other")) }
        assertFailsWith<IllegalArgumentException> { verify(installed = emptySet()) }
        assertFailsWith<IllegalArgumentException> { verify(archive = emptySet()) }
        assertFailsWith<IllegalArgumentException> { verify(installed = setOf("new"), archive = setOf("old")) }
    }
    @Test fun multipleSignersRequireExactSets() {
        verify(installed = setOf("a", "b"), archive = setOf("b", "a"))
        assertFailsWith<IllegalArgumentException> { verify(installed = setOf("a", "b"), archive = setOf("a")) }
        assertFailsWith<IllegalArgumentException> { verify(installed = setOf("a"), archive = setOf("a", "b")) }
    }
    @Test fun packageVersionAndManifestBindingAreRequired() {
        assertFailsWith<IllegalArgumentException> { verify(archivePackage = "other.package") }
        assertFailsWith<IllegalArgumentException> { verify(installedCode = 2) }
        assertFailsWith<IllegalArgumentException> { verify(installedCode = 3) }
        assertFailsWith<IllegalArgumentException> { verify(expectedCode = 3) }
    }
    @Test fun checksActualBytesAndDetectsTamperingOrTruncation() {
        val file = Files.createTempFile("obaflix-update-test", ".apk").toFile()
        try {
            val bytes = "verified test data".toByteArray()
            file.writeBytes(bytes)
            val release = DirectApkUpdate("1.0", 2, "https://app.obaflix.online/test-only.apk",
                bytes.size.toLong(), certificateSha256(bytes), "")
            verifyUpdateFile(file, release)
            file.writeBytes("modified test data".toByteArray().copyOf(bytes.size))
            assertFailsWith<IllegalArgumentException> { verifyUpdateFile(file, release) }
            file.writeBytes(byteArrayOf(1))
            assertFailsWith<IllegalArgumentException> { verifyUpdateFile(file, release) }
            file.delete()
            assertFailsWith<IllegalArgumentException> { verifyUpdateFile(file, release) }
        } finally { file.delete() }
    }
    @Test fun sha256UsesTheExpectedAlgorithm() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", certificateSha256("abc".toByteArray()))
    }
}
