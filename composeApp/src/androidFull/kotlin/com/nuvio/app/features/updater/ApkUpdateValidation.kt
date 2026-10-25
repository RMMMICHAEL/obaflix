package com.nuvio.app.features.updater

import java.io.File
import java.security.MessageDigest

internal fun certificateSha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

internal fun verifyUpdateFile(file: File, release: DirectApkUpdate) {
    require(file.isFile && file.length() == release.size) { "Tamanho do APK não confere" }
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
    }
    val actual = digest.digest().joinToString("") { "%02x".format(it) }
    require(actual == release.sha256) { "SHA256 do APK não confere" }
}

internal fun verifyUpdateIdentity(
    installedPackage: String,
    archivePackage: String,
    installedCode: Long,
    archiveCode: Long,
    expectedCode: Long,
    installedSigners: Set<String>,
    archiveSigners: Set<String>,
) {
    require(installedPackage == archivePackage) { "O APK pertence a outro aplicativo" }
    require(archiveCode == expectedCode && archiveCode > installedCode) { "versionCode do APK inválido" }
    require(installedSigners.isNotEmpty() && archiveSigners.isNotEmpty()) { "Assinatura do APK ausente" }
    require(installedSigners == archiveSigners) { "Assinatura do APK incompatível com o aplicativo instalado" }
}
