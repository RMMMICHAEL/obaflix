package com.obaflix.tv.assinatura

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A vitrine de planos: estados dos cards, textos, foco e D-pad.
 *
 * O comportamento de foco do Compose so se observa em aparelho. O que se trava
 * aqui e a regra que a tela consulta para decidir o foco inicial, a restauracao
 * e o vizinho de cada seta — se ela estiver certa, a fiacao em `TelaPlanos` so
 * repassa.
 */
class PlanosTvTest {

    private fun cards(planoId: String?, ativa: Boolean) = cardsDosPlanos(ContaDoPlano(planoId, ativa))

    @Test
    fun `conta gratuita recebe Assinar em cada plano`() {
        val c = cards("gratuito", ativa = false)
        assertEquals(listOf("basic", "plus", "premium"), c.map { it.plano.id })
        assertTrue(c.none { it.atual })
        assertEquals(listOf("Assinar", "Assinar", "Assinar"), c.map { it.acao.rotulo })
    }

    @Test
    fun `conta Basico ve Basico atual e upgrade para Plus e Premium`() {
        val c = cards("basic", ativa = true)
        assertEquals(listOf(true, false, false), c.map { it.atual })
        assertEquals(listOf(AcaoDoPlano.Nenhuma, AcaoDoPlano.FazerUpgrade, AcaoDoPlano.FazerUpgrade), c.map { it.acao })
        assertEquals("Plano atual", c[0].selo)
        assertEquals("Fazer upgrade", c[1].acao.rotulo)
    }

    @Test
    fun `conta Plus ve Plus atual e upgrade so para Premium`() {
        val c = cards("plus", ativa = true)
        assertEquals(listOf(false, true, false), c.map { it.atual })
        assertEquals(listOf(AcaoDoPlano.Nenhuma, AcaoDoPlano.Nenhuma, AcaoDoPlano.FazerUpgrade), c.map { it.acao })
    }

    @Test
    fun `conta Premium ve Premium atual sem nenhum CTA`() {
        val c = cards("premium", ativa = true)
        assertEquals(listOf(false, false, true), c.map { it.atual })
        assertTrue(c.all { it.acao == AcaoDoPlano.Nenhuma })
        assertTrue(c.all { it.acao.rotulo == null })
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
    fun `assinatura ativa de plano que a vitrine nao conhece nao ganha Assinar`() {
        val c = cards("cortesia", ativa = true)
        assertTrue(c.none { it.atual })
        assertTrue(c.all { it.acao == AcaoDoPlano.Nenhuma })
    }

    @Test
    fun `selos e cores de cada plano`() {
        val c = cards(null, ativa = false)
        assertNull(c[0].selo)
        assertEquals("Mais escolhido", c[1].selo)
        assertEquals("Experiência completa", c[2].selo)
        assertEquals(
            listOf(TomDoPlano.Azul, TomDoPlano.Roxo, TomDoPlano.Ambar),
            CatalogoDePlanosTv.TODOS.map { it.tom },
        )
    }

    @Test
    fun `precos e periodo`() {
        assertEquals(listOf("R$ 10", "R$ 19,90", "R$ 29,90"), CatalogoDePlanosTv.TODOS.map { it.preco })
        assertTrue(CatalogoDePlanosTv.TODOS.all { it.periodo == "30 dias" })
    }

    @Test
    fun `beneficios de cada plano`() {
        fun textos(p: PlanoTv) = p.beneficios.map { it.texto }

        CatalogoDePlanosTv.TODOS.forEach { assertTrue(it.id, "2 telas" in textos(it)) }

        val basico = CatalogoDePlanosTv.BASICO
        assertTrue("Qualidade HD" in textos(basico))
        assertTrue("Servidor VIP opcional" in textos(basico))
        assertTrue("Downloads com anúncio" in textos(basico))
        assertFalse(basico.beneficios.first { it.texto.startsWith("Canais") }.incluido)
        assertTrue("o Basico nao anuncia suporte", textos(basico).none { it.startsWith("Suporte") })

        val plus = CatalogoDePlanosTv.PLUS
        assertTrue("Qualidade Full HD" in textos(plus))
        assertTrue("Canais de TV incluídos" in textos(plus))
        assertTrue("Servidor VIP incluso" in textos(plus))
        assertTrue("Suporte" in textos(plus))

        val premium = CatalogoDePlanosTv.PREMIUM
        assertTrue("Qualidade até 4K" in textos(premium))
        assertTrue("Servidor VIP incluso" in textos(premium))
        assertTrue("Suporte prioritário" in textos(premium))
    }

    @Test
    fun `adicional VIP nao e vendido nesta versao`() {
        CatalogoDePlanosTv.TODOS.flatMap { it.beneficios }.forEach {
            assertFalse(it.texto, it.texto.contains("5,90"))
            assertFalse(it.texto, it.texto.contains("Contratar"))
        }
    }

    @Test
    fun `foco inicial previsivel`() {
        assertEquals("gratuita comeca no Plus", 1, focoInicialDosPlanos(cards("gratuito", false)))
        assertEquals("Basico comeca no primeiro upgrade", 1, focoInicialDosPlanos(cards("basic", true)))
        assertEquals("Plus comeca no Premium", 2, focoInicialDosPlanos(cards("plus", true)))
        assertEquals("Premium comeca no plano atual", 2, focoInicialDosPlanos(cards("premium", true)))
        assertEquals(0, focoInicialDosPlanos(emptyList()))
    }

    @Test
    fun `foco salvo e restaurado na volta`() {
        val c = cards("gratuito", false)
        assertEquals(0, focoDosPlanos(0, c))
        assertEquals(2, focoDosPlanos(2, c))
        assertEquals("fora da lista cai no inicial", 1, focoDosPlanos(7, c))
        assertEquals(1, focoDosPlanos(null, c))
    }

    @Test
    fun `D-pad anda entre os cards e para nas pontas`() {
        assertEquals(0, cardVizinho(0, -1, 3))
        assertEquals(1, cardVizinho(0, +1, 3))
        assertEquals(2, cardVizinho(1, +1, 3))
        assertEquals(2, cardVizinho(2, +1, 3))
        assertEquals(1, cardVizinho(2, -1, 3))
        assertEquals(0, cardVizinho(0, +1, 0))
    }
}
