package com.obaflix.tv.assinatura

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A vitrine de planos na TV: estados, foco e D-pad sobre dados do servidor.
 *
 * Os planos abaixo imitam a resposta de `/api/billing/plans`. O APK nao tem
 * tabela propria — o teste de contrato garante que nenhum preco esta escrito no
 * codigo da TV.
 */
class PlanosTvTest {

    private fun preco(id: String, centavos: Int) = PrecoDoPlano("p_$id", "30 dias", 30, centavos, "BRL")

    private val gratuito = PlanoTv("gratuito", "Gratuito", null, TomDoPlano.Neutro, emptyList(), emptyList())
    private val basico = PlanoTv("basic", "Básico", null, TomDoPlano.Azul, emptyList(), listOf(preco("b", 1000)))
    private val plus = PlanoTv("plus", "Plus", "Mais escolhido", TomDoPlano.Roxo, emptyList(), listOf(preco("p", 1990)))
    private val premium = PlanoTv("premium", "Premium", "Experiência completa", TomDoPlano.Ambar, emptyList(), listOf(preco("x", 2990)))
    private val servidor = listOf(gratuito, basico, plus, premium)

    private fun cards(planoId: String?, ativa: Boolean, planos: List<PlanoTv> = servidor) =
        cardsDosPlanos(planos, ContaDoPlano(planoId, ativa))

    @Test
    fun `o gratuito nao vira card e a ordem e a do servidor`() {
        assertEquals(listOf("basic", "plus", "premium"), cards(null, false).map { it.plano.id })
        assertEquals(listOf(1, 2, 3), cards(null, false).map { it.nivel })
    }

    @Test
    fun `conta gratuita recebe Assinar em cada plano`() {
        val c = cards("gratuito", ativa = false)
        assertTrue(c.none { it.atual })
        assertEquals(listOf("Assinar", "Assinar", "Assinar"), c.map { it.acao.rotulo })
    }

    @Test
    fun `conta Basico ve Basico atual e upgrade nos superiores`() {
        val c = cards("basic", ativa = true)
        assertEquals(listOf(true, false, false), c.map { it.atual })
        assertEquals(listOf(AcaoDoPlano.Nenhuma, AcaoDoPlano.FazerUpgrade, AcaoDoPlano.FazerUpgrade), c.map { it.acao })
        assertEquals("Plano atual", c[0].selo)
    }

    @Test
    fun `conta Plus ve Plus atual e upgrade so para Premium`() {
        val c = cards("plus", ativa = true)
        assertEquals(listOf(false, true, false), c.map { it.atual })
        assertEquals(listOf(AcaoDoPlano.Nenhuma, AcaoDoPlano.Nenhuma, AcaoDoPlano.FazerUpgrade), c.map { it.acao })
    }

    @Test
    fun `conta Premium ve Premium atual sem acao nenhuma`() {
        val c = cards("premium", ativa = true)
        assertEquals(listOf(false, false, true), c.map { it.atual })
        assertTrue(c.all { !it.acao.acionavel })
    }

    @Test
    fun `downgrade nunca e oferecido`() {
        for (atual in listOf("basic", "plus", "premium")) {
            val c = cards(atual, ativa = true)
            val indice = c.indexOfFirst { it.atual }
            c.take(indice + 1).forEach { assertEquals(atual, AcaoDoPlano.Nenhuma, it.acao) }
        }
    }

    @Test
    fun `plano sem preco no servidor nao e oferecido`() {
        val semPreco = listOf(basico.copy(precos = emptyList()), plus, premium)
        val c = cards(null, false, semPreco)
        assertEquals(AcaoDoPlano.Indisponivel, c[0].acao)
        assertFalse(c[0].acao.acionavel)
        assertEquals(AcaoDoPlano.Assinar, c[1].acao)
    }

    @Test
    fun `assinatura ativa de plano desconhecido nao ganha Assinar`() {
        assertTrue(cards("cortesia", ativa = true).all { it.acao == AcaoDoPlano.Nenhuma })
    }

    @Test
    fun `selos vem do servidor e Plano atual tem prioridade`() {
        val c = cards(null, false)
        assertNull(c[0].selo)
        assertEquals("Mais escolhido", c[1].selo)
        assertEquals("Experiência completa", c[2].selo)
        assertEquals("Plano atual", cards("premium", true)[2].selo)
    }

    @Test
    fun `tema do servidor vira tom, desconhecido vira neutro`() {
        assertEquals(TomDoPlano.Azul, tomDoTema("azul"))
        assertEquals(TomDoPlano.Roxo, tomDoTema("roxo"))
        assertEquals(TomDoPlano.Ambar, tomDoTema("ambar"))
        assertEquals(TomDoPlano.Neutro, tomDoTema(null))
        assertEquals(TomDoPlano.Neutro, tomDoTema("verde"))
    }

    @Test
    fun `preco formatado a partir dos centavos do servidor`() {
        assertEquals("R$ 10,00", formatarPreco(1000, "BRL"))
        assertEquals("R$ 19,90", formatarPreco(1990, "BRL"))
        assertEquals("R$ 284,90", formatarPreco(28490, "BRL"))
        assertEquals("R$ 1.234,50", formatarPreco(123450, "BRL"))
        assertEquals("USD 5,00", formatarPreco(500, "USD"))
    }

    @Test
    fun `card mostra a menor duracao disponivel`() {
        val varias = plus.copy(
            precos = listOf(
                PrecoDoPlano("a", "1 ano", 365, 18990, "BRL"),
                PrecoDoPlano("b", "30 dias", 30, 1990, "BRL"),
            ),
        )
        assertEquals("b", varias.precoDeEntrada?.id)
    }

    @Test
    fun `foco inicial previsivel`() {
        assertEquals("sem plano atual: o recomendado", 1, focoInicialDosPlanos(cards("gratuito", false)))
        assertEquals("Basico: primeiro upgrade", 1, focoInicialDosPlanos(cards("basic", true)))
        assertEquals("Plus: Premium", 2, focoInicialDosPlanos(cards("plus", true)))
        assertEquals("Premium: o atual", 2, focoInicialDosPlanos(cards("premium", true)))
        assertEquals(0, focoInicialDosPlanos(emptyList()))
    }

    @Test
    fun `foco salvo e restaurado na volta`() {
        val c = cards("gratuito", false)
        assertEquals(2, focoDosPlanos(2, c))
        assertEquals("fora da lista cai no inicial", 1, focoDosPlanos(7, c))
    }

    @Test
    fun `D-pad anda entre os cards e para nas pontas`() {
        assertEquals(0, cardVizinho(0, -1, 3))
        assertEquals(1, cardVizinho(0, +1, 3))
        assertEquals(2, cardVizinho(2, +1, 3))
        assertEquals(1, cardVizinho(2, -1, 3))
        assertEquals(0, cardVizinho(0, +1, 0))
    }
}
