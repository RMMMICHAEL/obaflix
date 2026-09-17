package com.obaflix.tv.player

import com.google.zxing.BinaryBitmap
import com.google.zxing.EncodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.BarcodeFormat
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.QRCodeWriter
import com.obaflix.tv.assinatura.LinkDaPaginaDePlanos
import com.obaflix.tv.assinatura.LinkDoCheckoutDoPlano
import com.obaflix.tv.assinatura.PlanoTv
import com.obaflix.tv.assinatura.PrecoDoPlano
import com.obaflix.tv.assinatura.TomDoPlano
import com.obaflix.tv.assinatura.linkDoCheckoutDoPlano
import com.obaflix.tv.assinatura.podeIrParaQr
import com.obaflix.tv.assinatura.resolvedorDaContinuacao
import com.obaflix.tv.navegacao.Camada
import com.obaflix.tv.navegacao.Navegacao
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Escolha final do anuncio → QR direto ao checkout do plano.
 *
 * Os ids e precos aqui sao ficticios, no formato do servidor: o APK nao conhece
 * nenhum, tudo vem de `/api/billing/plans`.
 */
class AnuncioCheckoutTest {

    private val base = "https://obaflix.invalido"
    private val d = "desafio_1"
    private val video = "https://midia.invalido/anuncio.mp4"

    private fun preco(id: String, dias: Int) = PrecoDoPlano(id, "$dias dias", dias, 1000 + dias, "BRL")

    /** Com o gratuito (sem tema) no meio, e precos fora de ordem: a vitrine e o preco de entrada sao do servidor. */
    private val catalogo = listOf(
        PlanoTv("free", "Gratuito", null, TomDoPlano.Neutro, emptyList(), emptyList()),
        PlanoTv("basic", "Basico", null, TomDoPlano.Azul, emptyList(), listOf(preco("pp_basic_150", 150), preco("pp_basic_30", 30))),
        PlanoTv("plus", "Plus", "Mais", TomDoPlano.Roxo, emptyList(), listOf(preco("pp_plus_30", 30), preco("pp_plus_365", 365))),
        PlanoTv("premium", "Premium", null, TomDoPlano.Ambar, emptyList(), listOf(preco("pp_premium_30", 30))),
    )

    @Before
    fun limpar() {
        Navegacao.pilha.clear()
    }

    private fun escolhaFinal(): EtapaDaReproducao {
        var e: EtapaDaReproducao = EtapaDaReproducao.Autorizando
        e = avancar(e, EventoDaReproducao.Decidiu(DecisaoDeReproducao.PromocaoObrigatoria(d)))
        e = avancar(e, EventoDaReproducao.PromocaoIniciou(InicioDaPromocaoTv.Iniciada(video, 11)))
        return avancar(e, EventoDaReproducao.VideoTerminou)
    }

    /** O que a TV desenharia: gera o QR com zxing e le de volta. */
    private fun decodificarQr(conteudo: String): String {
        val matriz = QRCodeWriter().encode(conteudo, BarcodeFormat.QR_CODE, 300, 300, mapOf(EncodeHintType.MARGIN to 2))
        val fonte = object : LuminanceSource(matriz.width, matriz.height) {
            override fun getRow(y: Int, row: ByteArray?): ByteArray =
                ByteArray(width) { x -> if (matriz.get(x, y)) 0 else -1 }
            override fun getMatrix(): ByteArray =
                ByteArray(width * height) { i -> if (matriz.get(i % width, i / width)) 0 else -1 }
        }
        return QRCodeReader().decode(BinaryBitmap(HybridBinarizer(fonte))).text
    }

    /** O fluxo do OK num plano: acao → catalogo do servidor → camada → link do QR. */
    private fun qrDoPlano(alvo: AlvoDaEscolha): Pair<Camada.AssinarForaDaTv, String> {
        val acao = acaoDoOk(alvo) as AcaoDaEscolha.AssinarPlano
        val camada = continuacaoDaEscolha(acao, catalogo)!!
        val link = runBlocking { resolvedorDaContinuacao(base, camada.precoDoCheckout).resolver(camada.plano) }!!
        return camada to decodificarQr(link.urlDoQr)
    }

    @Test
    fun `anuncio termina, Basico abre o QR do checkout do Basico`() {
        assertTrue(escolhaFinal() is EtapaDaReproducao.EscolhaFinal)
        val (camada, qr) = qrDoPlano(AlvoDaEscolha.Basico)
        assertEquals("basic", camada.plano.id)
        assertEquals("preco de entrada e a menor duracao", "pp_basic_30", camada.precoDoCheckout!!.id)
        assertEquals("$base/checkout?planoId=basic&planoPrecoId=pp_basic_30", qr)
    }

    @Test
    fun `Plus abre o QR do checkout do Plus`() {
        val (camada, qr) = qrDoPlano(AlvoDaEscolha.Plus)
        assertEquals("plus", camada.plano.id)
        assertEquals("$base/checkout?planoId=plus&planoPrecoId=pp_plus_30", qr)
    }

    @Test
    fun `Premium abre o QR do checkout do Premium`() {
        val (camada, qr) = qrDoPlano(AlvoDaEscolha.Premium)
        assertEquals("premium", camada.plano.id)
        assertEquals("$base/checkout?planoId=premium&planoPrecoId=pp_premium_30", qr)
    }

    @Test
    fun `nenhum plano do anuncio passa pela pagina de planos`() {
        for (alvo in listOf(AlvoDaEscolha.Basico, AlvoDaEscolha.Plus, AlvoDaEscolha.Premium)) {
            val (camada, qr) = qrDoPlano(alvo)
            assertTrue(alvo.name, resolvedorDaContinuacao(base, camada.precoDoCheckout) is LinkDoCheckoutDoPlano)
            assertFalse(alvo.name, qr.contains("/planos"))
            assertTrue(alvo.name, podeIrParaQr(qr))
            assertEquals(alvo.name, setOf("planoId", "planoPrecoId"), qr.substringAfter("?").split("&").map { it.substringBefore("=") }.toSet())
        }
    }

    @Test
    fun `sem catalogo, sem plano ou sem preco nao abre o QR`() {
        val basico = acaoDoOk(AlvoDaEscolha.Basico) as AcaoDaEscolha.AssinarPlano
        assertNull(continuacaoDaEscolha(basico, null))
        assertNull(continuacaoDaEscolha(basico, emptyList()))
        assertNull(continuacaoDaEscolha(basico, listOf(catalogo[1].copy(precos = emptyList()))))
        assertNull(continuacaoDaEscolha(AcaoDaEscolha.AssinarPlano(5), catalogo))
        assertNull("id de preco malformado", linkDoCheckoutDoPlano(base, "basic", "pp&token=x"))
        assertNull("base insegura", linkDoCheckoutDoPlano("http://obaflix.invalido", "basic", "pp_1"))
    }

    @Test
    fun `BACK do QR retorna a escolha final do mesmo desafio, sem video`() {
        val player = Camada.Player(Pedido(conteudoId = "s1", conteudoTipo = "serie", titulo = "Serie", backdrop = null))
        Navegacao.abrir(player)
        // O que o portao grava antes de abrir o QR.
        player.memoria.escolhaPendente = d
        player.memoria.planoEscolhido = AlvoDaEscolha.Plus
        Navegacao.abrir(qrDoPlano(AlvoDaEscolha.Plus).first)

        assertTrue(Navegacao.voltar())
        assertSame(player, Navegacao.pilha.last())
        assertEquals(
            EtapaDaReproducao.EscolhaFinal(d, videoUrl = null),
            etapaInicial(player.autorizacaoPrevia, player.memoria.escolhaPendente),
        )
    }

    @Test
    fun `escolher plano nao pede a conclusao`() {
        val fim = escolhaFinal()
        for (alvo in listOf(AlvoDaEscolha.Basico, AlvoDaEscolha.Plus, AlvoDaEscolha.Premium)) {
            assertFalse(alvo.name, acaoDoOk(alvo) is AcaoDaEscolha.ContinuarGratis)
        }
        // Nenhum evento sai do OK num plano; a etapa que pede /api/ads/complete
        // (`ConcluindoPromocao`) nao e alcancada sem Continuar gratis.
        assertTrue(fim is EtapaDaReproducao.EscolhaFinal)
        assertFalse(fim is EtapaDaReproducao.ConcluindoPromocao)
        assertFalse(fim is EtapaDaReproducao.Liberada)
    }

    @Test
    fun `continuar gratis continua concluindo e liberando`() {
        assertEquals(AcaoDaEscolha.ContinuarGratis, acaoDoOk(AlvoDaEscolha.ContinuarGratis))
        var e = avancar(escolhaFinal(), EventoDaReproducao.EscolheuContinuarGratis)
        assertEquals(EtapaDaReproducao.ConcluindoPromocao(d), e)
        e = avancar(e, EventoDaReproducao.PromocaoConcluiu(ConclusaoDaPromocao.Concedida("c_1")))
        assertEquals(EtapaDaReproducao.Liberada("c_1"), e)
    }

    @Test
    fun `fluxo normal Planos, plano, QR continua na pagina de planos`() {
        // TelaPlanos abre `Camada.AssinarForaDaTv(card.plano)`, sem preco de checkout.
        val camada = Camada.AssinarForaDaTv(catalogo[2])
        assertNull(camada.precoDoCheckout)
        val resolvedor = resolvedorDaContinuacao(base, camada.precoDoCheckout)
        assertTrue(resolvedor is LinkDaPaginaDePlanos)
        val link = runBlocking { resolvedor.resolver(camada.plano) }
        assertNotNull(link)
        assertEquals("$base/planos?plano=plus", decodificarQr(link!!.urlDoQr))
    }
}
