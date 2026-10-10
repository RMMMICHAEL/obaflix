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
        assertNull(v[0].grupoAudio)
    }

    @Test
    fun `virgula dentro de CODECS nao divide o atributo`() {
        val atributos = HlsPlaylist.atributosDe("""BANDWIDTH=2400000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720""")
        assertEquals("2400000", atributos["BANDWIDTH"])
        assertEquals("avc1.4d401f,mp4a.40.2", atributos["CODECS"])
        assertEquals("1280x720", atributos["RESOLUTION"])
    }

    @Test
    fun `escolhe a variante de maior banda`() {
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
        assertTrue(m.segmentos.all { it.faixa == null })
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
    fun `detecta playlist criptografada`() {
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

    // -- BYTERANGE -------------------------------------------------------------

    @Test
    fun `byterange com offset explicito`() {
        val texto = "#EXTM3U\n#EXTINF:4.0,\n#EXT-X-BYTERANGE:75232@0\nv.ts\n"
        val faixa = HlsPlaylist.parseMedia(texto).segmentos.single().faixa!!
        assertEquals(0L, faixa.offset)
        assertEquals(75232L, faixa.tamanho)
        assertEquals("bytes=0-75231", faixa.comoRange())
    }

    @Test
    fun `byterange com offsets implicitos consecutivos no mesmo recurso`() {
        // Sem @offset, cada faixa comeca logo apos a anterior do MESMO recurso.
        val texto = """
            #EXTM3U
            #EXTINF:4.0,
            #EXT-X-BYTERANGE:100@0
            v.ts
            #EXTINF:4.0,
            #EXT-X-BYTERANGE:100
            v.ts
            #EXTINF:4.0,
            #EXT-X-BYTERANGE:50
            v.ts
        """.trimIndent()
        val faixas = HlsPlaylist.parseMedia(texto).segmentos.map { it.faixa!!.comoRange() }
        assertEquals(listOf("bytes=0-99", "bytes=100-199", "bytes=200-249"), faixas)
    }

    @Test
    fun `byterange nao herda offset entre recursos diferentes`() {
        val texto = """
            #EXTM3U
            #EXTINF:4.0,
            #EXT-X-BYTERANGE:100@0
            a.ts
            #EXTINF:4.0,
            #EXT-X-BYTERANGE:100
            b.ts
        """.trimIndent()
        val segs = HlsPlaylist.parseMedia(texto).segmentos
        assertEquals("bytes=0-99", segs[0].faixa!!.comoRange())
        // b.ts comeca do zero, nao herda o 100 de a.ts.
        assertEquals("bytes=0-99", segs[1].faixa!!.comoRange())
    }

    @Test
    fun `byterange invalido ou zero vira faixa nula`() {
        assertNull(HlsPlaylist.parseMedia("#EXTM3U\n#EXTINF:4,\n#EXT-X-BYTERANGE:0@0\nv.ts\n").segmentos.single().faixa)
        assertNull(HlsPlaylist.parseMedia("#EXTM3U\n#EXTINF:4,\n#EXT-X-BYTERANGE:abc\nv.ts\n").segmentos.single().faixa)
    }

    // -- Audio em faixa separada ----------------------------------------------

    private val MASTER_AUDIO_MISTO = """
        #EXTM3U
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="pt",URI="audio/pt.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
        360/v.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
        720/v.m3u8
    """.trimIndent()

    @Test
    fun `grupo de audio com URI e externo`() {
        assertEquals(setOf("aud"), HlsPlaylist.gruposAudioExternos(MASTER_AUDIO_MISTO))
    }

    @Test
    fun `grupo de audio sem URI e embutido, nao externo`() {
        val texto = """
            #EXTM3U
            #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="pt"
            #EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aud"
            v.m3u8
        """.trimIndent()
        assertTrue(HlsPlaylist.gruposAudioExternos(texto).isEmpty())
        val v = HlsPlaylist.parseMaster(texto).single()
        assertFalse(HlsPlaylist.temAudioSeparado(v, HlsPlaylist.gruposAudioExternos(texto)))
    }

    @Test
    fun `so a variante com audio externo e filtrada, a embutida permanece`() {
        val variantes = HlsPlaylist.parseMaster(MASTER_AUDIO_MISTO)
        val externos = HlsPlaylist.gruposAudioExternos(MASTER_AUDIO_MISTO)
        val compat = HlsPlaylist.variantesCompativeis(variantes, externos)
        // A 360 (AUDIO="aud" externo) saiu; a 720 (embutida) ficou, com indice original 1.
        assertEquals(listOf(1), compat.map { it.index })
        assertEquals("720/v.m3u8", compat.single().value.uri)
    }

    @Test
    fun `todas as variantes com audio externo nao deixam nenhuma compativel`() {
        val texto = """
            #EXTM3U
            #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="a.m3u8"
            #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"
            360/v.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="aud"
            720/v.m3u8
        """.trimIndent()
        val variantes = HlsPlaylist.parseMaster(texto)
        val externos = HlsPlaylist.gruposAudioExternos(texto)
        assertTrue(HlsPlaylist.variantesCompativeis(variantes, externos).isEmpty())
    }
}
