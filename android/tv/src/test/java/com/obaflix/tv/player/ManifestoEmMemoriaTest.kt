package com.obaflix.tv.player

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Contrato do `DataSource` que serve o manifesto do player externo.
 *
 * A regressão que estes testes existem para impedir derrubou TODA a reprodução
 * da TV — inclusive fontes que nada tinham a ver com o player externo — porque
 * o embrulho era criado para toda mídia e explodia na **construção**, antes de
 * qualquer I/O. Compilava perfeitamente.
 *
 * ## O que este arquivo cobre, e o que não cobre
 *
 * `DataSpec` exige `android.net.Uri`, que no android.jar de teste unitário é um
 * stub: `Uri.parse` devolve `null` e `DataSpec.build()` recusa. Trazer
 * Robolectric só por isso seria caro demais para o que se ganha.
 *
 * A saída foi tirar a decisão inteira de dentro do `DataSource`:
 * `corpoPara(uri)` responde, em texto puro, quem é servido da memória e quem vai
 * para a rede — e é isso que os testes exercitam, junto com o opt-in da fábrica.
 * O comportamento byte a byte (offset, EOF, faixa fora do arquivo) é do
 * `ByteArrayDataSource` do próprio Media3, testado lá; aqui só se confirma, sem
 * `Uri`, que ele aceita os bytes que guardamos e que **não** aceita array vazio
 * — que foi exatamente a causa da regressão.
 */
class ManifestoEmMemoriaTest {

    private val MASTER_URL = "https://cdn.exemplo/cdn/hls/abc/master.txt"
    private val MANIFESTO =
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n360/index.m3u8\n"

    private class RedeFalsa : DataSource {
        override fun open(dataSpec: DataSpec): Long = 0
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
            C.RESULT_END_OF_INPUT
        override fun getUri(): Uri? = null
        override fun close() = Unit
        override fun addTransferListener(transferListener: TransferListener) = Unit
    }

    private class FabricaFalsa : DataSource.Factory {
        val criadas = mutableListOf<RedeFalsa>()
        override fun createDataSource(): DataSource =
            RedeFalsa().also { criadas.add(it) }
    }

    // ── Opt-in: sem manifesto, nada muda ───────────────────────────────────

    @Test
    fun `sem manifesto armado a fabrica devolve a fonte de rede sem embrulho`() {
        val rede = FabricaFalsa()
        val fabrica = ManifestoEmMemoria(rede)

        val fonte = fabrica.createDataSource()

        // Identidade, e nao "se comporta parecido": e a garantia de que MP4,
        // HLS comum e Fonte Canais usam exatamente o pipeline de antes desta
        // classe existir. Era isto que a regressao quebrava.
        assertSame(rede.criadas.single(), fonte)
    }

    @Test
    fun `com manifesto armado a fabrica embrulha`() {
        val rede = FabricaFalsa()
        val fabrica = ManifestoEmMemoria(rede)
        fabrica.armar(MASTER_URL, MANIFESTO)

        assertFalse(fabrica.createDataSource() is RedeFalsa)
    }

    @Test
    fun `limpar devolve a fabrica ao caminho sem embrulho`() {
        val rede = FabricaFalsa()
        val fabrica = ManifestoEmMemoria(rede)
        fabrica.armar(MASTER_URL, MANIFESTO)
        fabrica.createDataSource()

        fabrica.limpar()

        val criada = fabrica.createDataSource()
        assertSame(rede.criadas.last(), criada)
    }

    @Test
    fun `manifesto vazio nao arma nada`() {
        val rede = FabricaFalsa()
        val fabrica = ManifestoEmMemoria(rede)

        fabrica.armar(MASTER_URL, "")

        assertFalse(fabrica.casa(MASTER_URL))
        val criada = fabrica.createDataSource()
        assertSame(rede.criadas.single(), criada)
    }

    // ── Decisao por URI ────────────────────────────────────────────────────

    @Test
    fun `serve somente a URI exata do master`() {
        val fabrica = ManifestoEmMemoria(FabricaFalsa())
        assertNull("nada armado", fabrica.corpoPara(MASTER_URL))

        fabrica.armar(MASTER_URL, MANIFESTO)

        assertArrayEquals(MANIFESTO.toByteArray(), fabrica.corpoPara(MASTER_URL))
        assertNull("child playlist", fabrica.corpoPara("https://cdn.exemplo/cdn/hls/abc/360/index.m3u8"))
        assertNull("segmento", fabrica.corpoPara("https://cdn.exemplo/cdn/hls/abc/360/seg0.ts"))
        assertNull("chave", fabrica.corpoPara("https://cdn.exemplo/cdn/hls/abc/key.bin"))
        assertNull("outro host", fabrica.corpoPara("https://outro.tld/cdn/hls/abc/master.txt"))
        assertNull("query diferente", fabrica.corpoPara(MASTER_URL + "?t=2"))
        assertNull("prefixo", fabrica.corpoPara("https://cdn.exemplo/cdn/hls/abc/"))
        assertNull(fabrica.corpoPara(null))
    }

    @Test
    fun `armar de novo troca o alvo e o corpo por inteiro`() {
        val fabrica = ManifestoEmMemoria(FabricaFalsa())
        fabrica.armar(MASTER_URL, MANIFESTO)

        val outro = "https://cdn.exemplo/cdn/hls/xyz/master.txt"
        fabrica.armar(outro, "#EXTM3U\n#EXTINF:6.0,\na.ts\n")

        assertNull("o master anterior nao pode sobreviver a troca de fonte", fabrica.corpoPara(MASTER_URL))
        assertTrue(fabrica.casa(outro))
    }

    // ── Regressao: midia comum nunca depende do manifesto ──────────────────

    @Test
    fun `midia sem manifesto nunca casa e nunca embrulha`() {
        val rede = FabricaFalsa()
        val fabrica = ManifestoEmMemoria(rede)

        // Fonte Canais: MP4 direto, `manifesto_em_memoria=false`. Era esta que
        // o log de campo mostrou caindo junto com o Fire.
        val mp4 = "https://cdn.exemplo/series/x/169772.mp4"
        assertNull(fabrica.corpoPara(mp4))
        val criada = fabrica.createDataSource()
        assertSame(rede.criadas.single(), criada)

        // E mesmo com um manifesto de OUTRA fonte armado, o MP4 vai para a rede.
        fabrica.armar(MASTER_URL, MANIFESTO)
        assertNull(fabrica.corpoPara(mp4))
    }

    // ── Os bytes que guardamos servem ao Media3 ────────────────────────────

    @Test
    fun `os bytes guardados sao aceitos pelo ByteArrayDataSource do Media3`() {
        val fabrica = ManifestoEmMemoria(FabricaFalsa())
        fabrica.armar(MASTER_URL, MANIFESTO)

        // Construir e o passo que estourava. Aqui ele passa, e passa com o
        // conteudo real do manifesto.
        val bytes = fabrica.corpoPara(MASTER_URL)!!
        ByteArrayDataSource(bytes)
        assertEquals(MANIFESTO, String(bytes, Charsets.UTF_8))
    }

    @Test
    fun `array vazio continua sendo recusado pelo Media3`() {
        // A regressao em uma linha: um ByteArrayDataSource(ByteArray(0)) criado
        // como campo do embrulho, para toda midia. Se algum dia isto parar de
        // lancar, o teste avisa que a suposicao mudou.
        val erro = runCatching { ByteArrayDataSource(ByteArray(0)) }.exceptionOrNull()
        assertTrue(
            "esperava recusa do Media3 para array vazio, veio: $erro",
            erro is IllegalArgumentException,
        )
    }
}
