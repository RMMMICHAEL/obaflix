package com.obaflix.download

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

class HlsAssemblerTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = createTempDir(prefix = "obaflix-assembler")
    }

    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    // Fake do .part em disco: exercita montar() e finalizar() sem Android.
    private inner class ParcialFake(
        nomeParte: String,
        private val permiteRename: Boolean = true,
        private val falhaCopia: Boolean = false,
    ) : ArquivoParcial {
        val parte = File(dir, nomeParte)
        var finalCriado: File? = null
        private val saida = parte.outputStream().buffered()

        override fun escrever(bytes: ByteArray) {
            saida.write(bytes)
        }

        private fun fechar() {
            runCatching { saida.flush(); saida.close() }
        }

        override fun renomearPara(nomeFinal: String): String? {
            fechar()
            if (!permiteRename) return null
            val alvo = File(dir, nomeFinal)
            return if (parte.renameTo(alvo)) {
                finalCriado = alvo
                alvo.absolutePath
            } else {
                null
            }
        }

        override fun copiarParaFinal(nomeFinal: String, mime: String): String {
            fechar()
            val alvo = File(dir, nomeFinal)
            try {
                if (falhaCopia) {
                    alvo.writeBytes(ByteArray(0)) // final incompleto antes da falha
                    throw RuntimeException("copia falhou")
                }
                parte.copyTo(alvo, overwrite = true)
                if (alvo.length() <= 0L) throw RuntimeException("copia vazia")
            } catch (e: Throwable) {
                alvo.delete()
                parte.delete()
                throw e
            }
            parte.delete()
            finalCriado = alvo
            return alvo.absolutePath
        }

        override fun descartar() {
            fechar()
            parte.delete()
        }
    }

    private fun midia(segmentos: List<String>, init: String? = null) =
        HlsPlaylist.Midia(
            segmentos = segmentos.map { HlsPlaylist.Segmento(it, null) },
            initSegment = init?.let { HlsPlaylist.Segmento(it, null) },
            criptografada = false,
        )

    private fun montar(
        midia: HlsPlaylist.Midia,
        urlDaMidia: String,
        parcial: ArquivoParcial,
        destinoPublico: (String) -> Boolean = { true },
        baixar: BaixarBytes,
    ): Pair<Container, Long> = runBlocking {
        HlsAssembler.montar(midia, urlDaMidia, baixar, destinoPublico, parcial)
    }

    private fun ts(vararg extra: Int) = byteArrayOf(0x47) + extra.map { it.toByte() }.toByteArray()
    private fun fmp4(caixa: String, vararg extra: Int) =
        byteArrayOf(0, 0, 0, 0) + caixa.toByteArray(Charsets.US_ASCII) + extra.map { it.toByte() }.toByteArray()

    // -- Identificacao de container (pelos bytes) -----------------------------

    @Test
    fun `identifica fMP4 pela caixa e MPEG-TS pelo sync byte`() {
        assertEquals(Container.FMP4, HlsAssembler.identificarContainer(fmp4("ftyp")))
        assertEquals(Container.FMP4, HlsAssembler.identificarContainer(fmp4("styp")))
        assertEquals(Container.FMP4, HlsAssembler.identificarContainer(fmp4("moof")))
        assertEquals(Container.TS, HlsAssembler.identificarContainer(ts(1, 2, 3)))
        assertEquals(Container.DESCONHECIDO, HlsAssembler.identificarContainer(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8)))
    }

    // -- Concatenacao ---------------------------------------------------------

    @Test
    fun `TS - tres segmentos viram um unico ts com os bytes na ordem`() {
        val dados = mapOf("s0.ts" to ts(1), "s1.ts" to ts(2), "s2.ts" to ts(3))
        val parcial = ParcialFake("video.part")
        val (container, bytes) = montar(
            midia = midia(listOf("s0.ts", "s1.ts", "s2.ts")),
            urlDaMidia = "https://cdn.exemplo.com/x/media.m3u8",
            parcial = parcial,
            baixar = { url, _ -> dados.getValue(url.substringAfterLast('/')) },
        )
        assertEquals(Container.TS, container)
        assertEquals(6L, bytes)
        assertEquals("ts", container.extensao())
        // Finaliza (esvazia o buffer) e confere os bytes no arquivo final.
        HlsAssembler.finalizar(parcial, "video.ts", container)
        assertArrayEquals(ts(1) + ts(2) + ts(3), File(dir, "video.ts").readBytes())
    }

    @Test
    fun `fMP4 - init aparece uma unica vez, antes dos fragmentos`() {
        val init = fmp4("ftyp", 9)
        val dados = mapOf("init.mp4" to init, "f1.m4s" to fmp4("moof", 1), "f2.m4s" to fmp4("moof", 2))
        val parcial = ParcialFake("video.part")
        val (container, _) = montar(
            midia = midia(listOf("f1.m4s", "f2.m4s"), init = "init.mp4"),
            urlDaMidia = "https://cdn.exemplo.com/x/media.m3u8",
            parcial = parcial,
            baixar = { url, _ -> dados.getValue(url.substringAfterLast('/')) },
        )
        assertEquals(Container.FMP4, container)
        assertEquals("mp4", container.extensao())
        HlsAssembler.finalizar(parcial, "video.mp4", container)
        val saida = File(dir, "video.mp4").readBytes()
        assertArrayEquals(init + fmp4("moof", 1) + fmp4("moof", 2), saida)
        // init exatamente uma vez: a caixa ftyp nao se repete.
        val ocorrencias = String(saida, Charsets.ISO_8859_1).split("ftyp").size - 1
        assertEquals(1, ocorrencias)
    }

    @Test
    fun `container vem dos bytes, nao da extensao da URL`() {
        val parcial = ParcialFake("v.part")
        val (c1, _) = montar(midia(listOf("mentiroso.ts")), "https://cdn/x/m.m3u8", parcial) { _, _ -> fmp4("ftyp") }
        assertEquals(Container.FMP4, c1)

        val parcial2 = ParcialFake("v2.part")
        val (c2, _) = montar(midia(listOf("mentiroso.mp4")), "https://cdn/x/m.m3u8", parcial2) { _, _ -> ts(1, 2) }
        assertEquals(Container.TS, c2)
    }

    @Test
    fun `container nao identificado vira FONTE_INCOMPATIVEL`() {
        val parcial = ParcialFake("v.part")
        val e = assertThrows(DownloadException::class.java) {
            montar(midia(listOf("x.ts")), "https://cdn/x/m.m3u8", parcial) { _, _ -> byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8) }
        }
        assertEquals(DownloadFailure.FONTE_INCOMPATIVEL, e.motivo)
    }

    @Test
    fun `destino privado no meio dos segmentos bloqueia a montagem`() {
        val parcial = ParcialFake("v.part")
        val e = assertThrows(DownloadException::class.java) {
            montar(
                midia(listOf("ok.ts", "ruim.ts")),
                "https://cdn/x/m.m3u8",
                parcial,
                destinoPublico = { url -> !url.endsWith("ruim.ts") },
            ) { _, _ -> ts(1) }
        }
        assertEquals(DownloadFailure.FONTE_INCOMPATIVEL, e.motivo)
    }

    // -- Finalizacao SAF ------------------------------------------------------

    @Test
    fun `finaliza por rename - so o arquivo final permanece`() {
        val parcial = ParcialFake("v.part", permiteRename = true)
        parcial.escrever(ts(1, 2, 3))
        val uri = HlsAssembler.finalizar(parcial, "Filme.ts", Container.TS)
        assertTrue(uri.endsWith("Filme.ts"))
        assertFalse(File(dir, "v.part").exists())
        assertTrue(File(dir, "Filme.ts").exists())
    }

    @Test
    fun `rename nao suportado cai na copia - so o final permanece`() {
        val parcial = ParcialFake("v.part", permiteRename = false)
        parcial.escrever(ts(1, 2, 3, 4))
        val uri = HlsAssembler.finalizar(parcial, "Filme.ts", Container.TS)
        assertTrue(uri.endsWith("Filme.ts"))
        assertFalse(File(dir, "v.part").exists())
        val finalFile = File(dir, "Filme.ts")
        assertTrue(finalFile.exists())
        assertArrayEquals(ts(1, 2, 3, 4), finalFile.readBytes())
    }

    @Test
    fun `falha na finalizacao nao deixa arquivo final parcial`() {
        val parcial = ParcialFake("v.part", permiteRename = false, falhaCopia = true)
        parcial.escrever(ts(1, 2, 3))
        assertThrows(RuntimeException::class.java) {
            HlsAssembler.finalizar(parcial, "Filme.ts", Container.TS)
        }
        assertFalse(File(dir, "Filme.ts").exists())
        assertFalse(File(dir, "v.part").exists())
    }

    @Test
    fun `descartar remove o part (cancelamento ou falha)`() {
        val parcial = ParcialFake("v.part")
        parcial.escrever(ts(1))
        assertTrue(File(dir, "v.part").exists())
        parcial.descartar()
        assertFalse(File(dir, "v.part").exists())
    }
}
