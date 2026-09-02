package com.obaflix.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/**
 * Cobre so [UpdateDownloader.sha256] — a parte que roda em JVM pura, sem
 * `Context`. O download em si (DownloadManager) e o FileProvider continuam
 * validados por build + instalacao manual, nao aqui.
 */
class UpdateDownloaderChecksumTest {

    private fun digestDireto(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes)
            .joinToString("") { "%02x".format(it) }

    @Test
    fun `sha256 de um arquivo pequeno bate com o digest direto`() {
        val arquivo = File.createTempFile("update-test-pequeno", ".bin")
        try {
            val conteudo = "obaflix".toByteArray()
            arquivo.writeBytes(conteudo)

            assertEquals(digestDireto(conteudo), UpdateDownloader.sha256(arquivo))
        } finally {
            arquivo.delete()
        }
    }

    @Test
    fun `sha256 de um arquivo maior que o buffer interno tambem bate`() {
        // 8192 e o tamanho do buffer de leitura; isto forca mais de uma
        // rodada do laco e cobre o caso de a leitura parar no meio de um
        // buffer cheio.
        val arquivo = File.createTempFile("update-test-grande", ".bin")
        try {
            val conteudo = ByteArray(8192 * 3 + 137) { (it % 256).toByte() }
            arquivo.writeBytes(conteudo)

            assertEquals(digestDireto(conteudo), UpdateDownloader.sha256(arquivo))
        } finally {
            arquivo.delete()
        }
    }

    @Test
    fun `conteudos diferentes produzem digests diferentes`() {
        val a = File.createTempFile("update-test-a", ".bin")
        val b = File.createTempFile("update-test-b", ".bin")
        try {
            a.writeBytes("versao-1".toByteArray())
            b.writeBytes("versao-2".toByteArray())

            assertNotEquals(UpdateDownloader.sha256(a), UpdateDownloader.sha256(b))
        } finally {
            a.delete()
            b.delete()
        }
    }
}
