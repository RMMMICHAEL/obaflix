package com.obaflix.download

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HlsPlaylistTest {

    private val MASTER = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
        360/index.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
        720/index.m3u8
    """.trimIndent()

    private val MIDIA = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-TARGETDURATION:6
        #EXT-X-MEDIA-SEQUENCE:0
        #EXTINF:6.000,
        seg0.ts
        #EXTINF:6.000,
        seg1.ts
        #EXT-X-ENDLIST
    """.trimIndent()

    @Test
    fun `reconhece master e playlist de midia`() {
        assertTrue(HlsPlaylist.ehMaster(MASTER))
        assertFalse(HlsPlaylist.ehMaster(MIDIA))
        assertTrue(HlsPlaylist.ehPlaylist(MASTER))
        assertFalse(HlsPlaylist.ehPlaylist("<html>403</html>"))
    }

    @Test
    fun `le as variantes do master`() {
        val v = HlsPlaylist.parseMaster(MASTER)
        assertEquals(2, v.size)
        assertEquals("360/index.m3u8", v[0].uri)
        assertEquals(800000L, v[0].bandwidth)
        assertEquals("640x360", v[0].resolucao)
    }

    @Test
    fun `virgula dentro de CODECS nao divide o atributo`() {
        // Dividir por virgula direto quebra justamente os manifestos com mais de
        // um codec, que sao a maioria.
        val atributos = HlsPlaylist.atributosDe("""BANDWIDTH=2400000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720""")
        assertEquals("2400000", atributos["BANDWIDTH"])
        assertEquals("avc1.4d401f,mp4a.40.2", atributos["CODECS"])
        assertEquals("1280x720", atributos["RESOLUTION"])
    }

    @Test
    fun `escolhe a variante de maior banda`() {
        // Baixar e diferente de reproduzir: o arquivo fica no aparelho.
        assertEquals("720/index.m3u8", HlsPlaylist.melhorVariante(HlsPlaylist.parseMaster(MASTER))!!.uri)
    }

    @Test
    fun `master sem variantes devolve nulo`() {
        assertNull(HlsPlaylist.melhorVariante(emptyList()))
    }

    @Test
    fun `uri da variante pode estar depois de linhas em branco`() {
        val comBranco = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\n\n\nv/i.m3u8\n"
        assertEquals("v/i.m3u8", HlsPlaylist.parseMaster(comBranco).single().uri)
    }

    @Test
    fun `le os segmentos da playlist`() {
        val m = HlsPlaylist.parseMedia(MIDIA)
        assertEquals(listOf("seg0.ts", "seg1.ts"), m.segmentos.map { it.uri })
        assertNull(m.initSegment)
        assertFalse(m.criptografada)
    }

    @Test
    fun `le o segmento de inicializacao do fMP4`() {
        val texto = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.0,\ns1.m4s\n"
        val m = HlsPlaylist.parseMedia(texto)
        assertEquals("init.mp4", m.initSegment!!.uri)
        assertEquals(listOf("s1.m4s"), m.segmentos.map { it.uri })
    }

    @Test
    fun `le byterange e associa ao segmento seguinte`() {
        val texto = "#EXTM3U\n#EXTINF:4.0,\n#EXT-X-BYTERANGE:75232@0\nv.ts\n"
        assertEquals("75232@0", HlsPlaylist.parseMedia(texto).segmentos.single().byteRange)
    }

    @Test
    fun `detecta playlist criptografada`() {
        // Baixar isto exigiria gravar a chave de conteudo na pasta do usuario.
        val texto = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k.key\"\n#EXTINF:4.0,\ns.ts\n"
        assertTrue(HlsPlaylist.parseMedia(texto).criptografada)
    }

    @Test
    fun `METHOD NONE nao conta como criptografada`() {
        val texto = "#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4.0,\ns.ts\n"
        assertFalse(HlsPlaylist.parseMedia(texto).criptografada)
    }

    @Test
    fun `resolve uri absoluta enraizada e relativa`() {
        val base = "https://cdn.exemplo.com/hls/720/index.m3u8"
        assertEquals(
            "https://outro.exemplo.com/a.ts",
            HlsPlaylist.resolver(base, "https://outro.exemplo.com/a.ts"),
        )
        assertEquals("https://cdn.exemplo.com/raiz.ts", HlsPlaylist.resolver(base, "/raiz.ts"))
        assertEquals("https://cdn.exemplo.com/hls/720/s1.ts", HlsPlaylist.resolver(base, "s1.ts"))
        assertEquals("https://cdn.exemplo.com/hls/s1.ts", HlsPlaylist.resolver(base, "../s1.ts"))
    }

    @Test
    fun `reescreve os segmentos para os arquivos locais`() {
        val base = "https://cdn.exemplo.com/hls/index.m3u8"
        val mapa = mapOf(
            "https://cdn.exemplo.com/hls/seg0.ts" to "seg00001.ts",
            "https://cdn.exemplo.com/hls/seg1.ts" to "seg00002.ts",
        )
        val saida = HlsPlaylist.reescreverParaLocal(MIDIA, base) { mapa[it] }

        assertTrue(saida.contains("seg00001.ts"))
        assertTrue(saida.contains("seg00002.ts"))
        // Nenhuma URL de origem sobra no manifesto gravado no aparelho.
        assertFalse(saida.contains("cdn.exemplo.com"))
        // As tags estruturais continuam intactas.
        assertTrue(saida.contains("#EXT-X-TARGETDURATION:6"))
        assertTrue(saida.contains("#EXT-X-ENDLIST"))
    }

    @Test
    fun `reescreve a uri do EXT-X-MAP`() {
        val texto = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.0,\ns1.m4s\n"
        val base = "https://cdn.exemplo.com/h/i.m3u8"
        val saida = HlsPlaylist.reescreverParaLocal(texto, base) {
            if (it.endsWith("init.mp4")) "init.mp4" else "seg00001.m4s"
        }
        assertTrue(saida.contains("#EXT-X-MAP:URI=\"init.mp4\""))
        assertTrue(saida.contains("seg00001.m4s"))
    }

    @Test
    fun `byterange sai do manifesto local`() {
        // Cada segmento virou um arquivo com exatamente aqueles bytes; um
        // intervalo remanescente faria o player ler o pedaco errado.
        val texto = "#EXTM3U\n#EXTINF:4.0,\n#EXT-X-BYTERANGE:100@0\nv.ts\n"
        val saida = HlsPlaylist.reescreverParaLocal(texto, "https://c.exemplo/i.m3u8") { "seg00001.ts" }
        assertFalse(saida.contains("#EXT-X-BYTERANGE"))
        assertTrue(saida.contains("seg00001.ts"))
    }

    @Test
    fun `segmento sem mapeamento fica como estava`() {
        val saida = HlsPlaylist.reescreverParaLocal(MIDIA, "https://c.exemplo/i.m3u8") { null }
        assertTrue(saida.contains("seg0.ts"))
    }

    @Test
    fun `byterange do HLS vira Range do HTTP com o indice final`() {
        // O HLS conta quantos bytes ler; o HTTP quer o ultimo indice inclusivo.
        assertEquals("bytes=0-99", MediaDownloader.faixaDeExtX("100@0"))
        assertEquals("bytes=200-299", MediaDownloader.faixaDeExtX("100@200"))
        assertEquals("bytes=0-99", MediaDownloader.faixaDeExtX("100"))
        assertNull(MediaDownloader.faixaDeExtX("0@0"))
        assertNull(MediaDownloader.faixaDeExtX("abc"))
    }
}
