package com.obaflix.download

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Nome de arquivo a partir de titulo livre.
 *
 * Um caractere invalido aqui nao daria erro na hora: o provedor de documentos
 * recusa a criacao so quando o download ja comecou, e a falha aparece como
 * "ESCRITA" sem dizer que a culpa era do titulo do episodio.
 */
class DownloadFolderTest {

    @Test
    fun `mantem um titulo normal`() {
        assertEquals("Breaking Bad S01E01.mp4", DownloadFolder.nomeSeguro("Breaking Bad S01E01", "mp4"))
    }

    @Test
    fun `preserva hifen e acentos`() {
        // Hifen e legal em nome de arquivo nos dois sistemas; trocar por espaco
        // deixaria "Serie - Ep 1" virar "Serie Ep 1".
        assertEquals("O Agente - Episodio 3.mp4", DownloadFolder.nomeSeguro("O Agente - Episodio 3", "mp4"))
        assertEquals("Coracao Selvagem.mp4", DownloadFolder.nomeSeguro("Coracao Selvagem", "mp4"))
    }

    @Test
    fun `remove os caracteres proibidos`() {
        val nome = DownloadFolder.nomeSeguro("""A/B\C:D*E?F"G<H>I|J""", "mp4")
        listOf("/", "\\", ":", "*", "?", "\"", "<", ">", "|").forEach {
            assertFalse("sobrou $it em $nome", nome.dropLast(4).contains(it))
        }
    }

    @Test
    fun `remove caracteres de controle`() {
        val nome = DownloadFolder.nomeSeguro("Ep 1", "mp4")
        assertFalse(nome.any { it.code < 0x20 })
        assertEquals("Ep 1.mp4", nome)
    }

    @Test
    fun `colapsa espacos repetidos`() {
        assertEquals("A B.mp4", DownloadFolder.nomeSeguro("A    B", "mp4"))
    }

    @Test
    fun `nao deixa espaco nas pontas`() {
        val nome = DownloadFolder.nomeSeguro("   Ep 1   ", "mp4")
        assertEquals("Ep 1.mp4", nome)
    }

    @Test
    fun `titulo vazio nao gera arquivo sem nome`() {
        assertEquals("video.mp4", DownloadFolder.nomeSeguro("", "mp4"))
        assertEquals("video.mp4", DownloadFolder.nomeSeguro("///", "mp4"))
    }

    @Test
    fun `limita o tamanho`() {
        // Alguns provedores truncam em silencio e produzem colisao entre dois
        // episodios de nome parecido.
        val nome = DownloadFolder.nomeSeguro("x".repeat(400), "mp4")
        assertTrue(nome.length <= 104)
        assertTrue(nome.endsWith(".mp4"))
    }

    @Test
    fun `nao termina o nome base com ponto`() {
        // "nome..mp4" e recusado por alguns provedores de documentos.
        assertEquals("Ep 1.mp4", DownloadFolder.nomeSeguro("Ep 1.", "mp4"))
    }

    @Test
    fun `extensao hls usada para a subpasta do manifesto`() {
        assertEquals("Ep 1.hls", DownloadFolder.nomeSeguro("Ep 1", "hls"))
    }
}
