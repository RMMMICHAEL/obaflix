package com.obaflix.download

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * As opcoes que o modal de qualidade mostra.
 *
 * O risco que estes testes cobrem nao e visual: e a pessoa escolher 480p e
 * receber 1080p, ou ver "720p" escrito num video que nao e 720p. Nos dois casos
 * o arquivo fica no aparelho dela e nada avisa que veio diferente.
 */
class QualidadeDownloadTest {

    private val BASE = "https://cdn.exemplo.com/hls/master.m3u8"

    private val MASTER_COM_RESOLUCAO = """
        #EXTM3U
        #EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
        1080/index.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
        720/index.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480
        480/index.m3u8
    """.trimIndent()

    private fun qualidadesDe(texto: String) =
        QualidadeDownload.deVariantes(HlsPlaylist.parseMaster(texto), BASE)

    // -- Multiplas qualidades -------------------------------------------------

    @Test
    fun `master com resolucao vira uma opcao por variante`() {
        val q = qualidadesDe(MASTER_COM_RESOLUCAO)
        assertEquals(listOf("1080p", "720p", "480p"), q.map { it.label })
    }

    @Test
    fun `maior primeiro`() {
        // E a ordem em que a pessoa procura, e a que qualquer seletor de
        // qualidade de player usa.
        assertEquals(listOf(1080, 720, 480), qualidadesDe(MASTER_COM_RESOLUCAO).map { it.altura })
    }

    @Test
    fun `cada opcao ja carrega a URL da propria variante`() {
        val q = qualidadesDe(MASTER_COM_RESOLUCAO)
        assertEquals("https://cdn.exemplo.com/hls/1080/index.m3u8", q[0].uri)
        assertEquals("https://cdn.exemplo.com/hls/480/index.m3u8", q[2].uri)
    }

    // -- O teste central: 480p tem de baixar 480p -----------------------------

    @Test
    fun `escolher 480p leva a URL de 480p, nao a da maior variante`() {
        val variantes = HlsPlaylist.parseMaster(MASTER_COM_RESOLUCAO)
        val escolhida = qualidadesDe(MASTER_COM_RESOLUCAO).single { it.label == "480p" }

        assertEquals("https://cdn.exemplo.com/hls/480/index.m3u8", escolhida.uri)

        // E, explicitamente, NAO e a de maior largura de banda — que e para onde
        // o downloader cairia se a escolha se perdesse no caminho.
        val maior = HlsPlaylist.melhorVariante(variantes)!!
        assertEquals("1080/index.m3u8", maior.uri)
        assertNotEquals(HlsPlaylist.resolver(BASE, maior.uri), escolhida.uri)
    }

    @Test
    fun `o id da opcao aponta para a variante certa dentro do master`() {
        // O id e a posicao no manifesto, nao a resolucao: e assim que o
        // downloader reencontra a variante escolhida se a URL guardada ainda
        // for um master.
        val variantes = HlsPlaylist.parseMaster(MASTER_COM_RESOLUCAO)
        val escolhida = qualidadesDe(MASTER_COM_RESOLUCAO).single { it.label == "480p" }

        val variante = HlsPlaylist.porId(variantes, escolhida.id)
        assertEquals("480/index.m3u8", variante!!.uri)
        assertEquals("854x480", variante.resolucao)
    }

    @Test
    fun `id inexistente nao resolve para outra variante`() {
        val variantes = HlsPlaylist.parseMaster(MASTER_COM_RESOLUCAO)
        assertNull(HlsPlaylist.porId(variantes, "v99"))
        assertNull(HlsPlaylist.porId(variantes, "padrao"))
        assertNull(HlsPlaylist.porId(variantes, "lixo"))
    }

    // -- Uma qualidade so -----------------------------------------------------

    @Test
    fun `master sem RESOLUTION vira opcao unica Padrao`() {
        // Deduzir "2.4 Mbps deve ser 720p" e inventar rotulo: a relacao entre
        // taxa de bits e resolucao muda por codec e por encoder.
        val semResolucao = """
            #EXTM3U
            #EXT-X-STREAM-INF:BANDWIDTH=2400000
            a/index.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=900000
            b/index.m3u8
        """.trimIndent()
        val q = qualidadesDe(semResolucao)
        assertEquals(1, q.size)
        assertEquals("Padrão", q[0].label)
        assertEquals(QualidadeDownload.ID_PADRAO, q[0].id)
        assertEquals(0, q[0].altura)
        assertNull("Padrao nao fixa variante: quem escolhe e o downloader", q[0].uri)
    }

    @Test
    fun `resolucao parcial derruba a lista inteira para Padrao`() {
        // Misturar "1080p" com um "Padrao" que na verdade e uma variante sem
        // nome faria o Padrao parecer mais uma qualidade na lista.
        val misto = """
            #EXTM3U
            #EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
            a/index.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=900000
            b/index.m3u8
        """.trimIndent()
        assertEquals(listOf("Padrão"), qualidadesDe(misto).map { it.label })
    }

    @Test
    fun `master sem variante nenhuma vira Padrao`() {
        assertEquals(listOf("Padrão"), QualidadeDownload.deVariantes(emptyList(), BASE).map { it.label })
    }

    @Test
    fun `variantes com a mesma altura nao viram dois botoes iguais`() {
        // Dois renditions 720p (audios diferentes) apareceriam como dois "720p"
        // indistinguiveis na tela.
        val duplicado = """
            #EXTM3U
            #EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
            a/index.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
            b/index.m3u8
        """.trimIndent()
        assertEquals(listOf("720p"), qualidadesDe(duplicado).map { it.label })
    }

    // -- Altura ---------------------------------------------------------------

    @Test
    fun `le a altura de RESOLUTION`() {
        assertEquals(1080, HlsPlaylist.alturaDe("1920x1080"))
        assertEquals(480, HlsPlaylist.alturaDe("854x480"))
    }

    @Test
    fun `resolucao ausente ou quebrada nao vira altura`() {
        assertEquals(0, HlsPlaylist.alturaDe(null))
        assertEquals(0, HlsPlaylist.alturaDe(""))
        assertEquals(0, HlsPlaylist.alturaDe("1920"))
        assertEquals(0, HlsPlaylist.alturaDe("1920x"))
        assertEquals(0, HlsPlaylist.alturaDe("axb"))
        assertEquals(0, HlsPlaylist.alturaDe("1920x0"))
    }

    // -- JSON que atravessa a ponte -------------------------------------------

    @Test
    fun `o JSON das qualidades nao carrega URL`() {
        // A URL da variante fica no lado nativo. Se ela viajasse ao JavaScript
        // apareceria no DOM e no state do React — a mesma regra do resto.
        val json = QualidadeDownload.listaParaJson(qualidadesDe(MASTER_COM_RESOLUCAO)).toString()
        assertTrue(json.contains("1080p"))
        assertTrue(!json.contains("cdn.exemplo.com"))
        assertTrue(!json.contains("index.m3u8"))
    }

    @Test
    fun `a escolha sobrevive no registro do download`() {
        val registro = DownloadRecord(
            id = 1,
            pid = "serie:1:t1:e1",
            titulo = "Ep 1",
            kind = MediaKind.HLS,
            qualidadeId = "v2",
            qualidadeLabel = "480p",
        )
        val voltou = DownloadRecord.deJson(registro.paraJson())
        assertEquals("v2", voltou.qualidadeId)
        assertEquals("480p", voltou.qualidadeLabel)
    }

    @Test
    fun `a qualidade continua legivel depois de terminar`() {
        // semSegredos apaga a autorizacao, nao a resposta a "qual versao deste
        // episodio esta gravada aqui?".
        val terminal = DownloadRecord(
            id = 1,
            pid = "p",
            titulo = "Ep 1",
            kind = MediaKind.HLS,
            state = DownloadState.CONCLUIDO,
            url = "https://cdn.exemplo.com/v.m3u8?token=abc",
            qualidadeId = "v2",
            qualidadeLabel = "480p",
        ).semSegredos()

        assertEquals("", terminal.url)
        assertEquals("480p", terminal.qualidadeLabel)
        assertTrue(terminal.paraJsonPublico().toString().contains("480p"))
    }
}
