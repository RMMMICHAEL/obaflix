package com.obaflix.tv.navegacao

import com.obaflix.tv.player.DecisaoDeReproducao
import com.obaflix.tv.player.Pedido
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * "Ver planos" e Voltar: a pilha de camadas.
 *
 * O cursor em si so se observa em aparelho. O que se prova aqui e o que a
 * restauracao precisa: voltar devolve a mesma instancia de origem — com a
 * memoria de foco que ela guardou —, e nenhuma entrada de planos prende a pessoa
 * numa pilha que so se desfaz com varios BACK.
 */
class NavegacaoPlanosTest {

    private val pedido = Pedido(conteudoId = "f1", conteudoTipo = "filme", titulo = "Filme", backdrop = null)

    @Before
    fun limpar() {
        Navegacao.pilha.clear()
    }

    @Test
    fun `Ver planos abre por cima da origem e Voltar retorna a ela`() {
        val player = Camada.Player(pedido)
        Navegacao.abrir(Camada.Detalhe("f1", "filme", null))
        Navegacao.abrir(player)

        Navegacao.abrirPlanos()
        assertTrue(Navegacao.pilha.last() is Camada.Planos)

        assertTrue(Navegacao.voltar())
        assertSame(player, Navegacao.pilha.last())
    }

    @Test
    fun `planos nao se empilham sobre planos`() {
        Navegacao.abrirPlanos()
        Navegacao.abrirPlanos()
        assertEquals(1, Navegacao.pilha.size)
    }

    @Test
    fun `escolher um plano e voltar restaura o card focado`() {
        Navegacao.abrirPlanos()
        val planos = Navegacao.pilha.last() as Camada.Planos
        planos.memoria.indiceFocado = 2

        Navegacao.abrir(Camada.AssinarForaDaTv("premium"))
        assertTrue(Navegacao.voltar())

        assertSame(planos, Navegacao.pilha.last())
        assertEquals(2, (Navegacao.pilha.last() as Camada.Planos).memoria.indiceFocado)
    }

    @Test
    fun `convite lembra que a pessoa foi aos planos`() {
        val player = Camada.Player(pedido)
        Navegacao.abrir(player)
        player.memoria.foiAosPlanos = true
        Navegacao.abrirPlanos()
        Navegacao.voltar()
        assertTrue((Navegacao.pilha.last() as Camada.Player).memoria.foiAosPlanos)
    }

    @Test
    fun `canal recusado troca pelos planos e Voltar cai na grade`() {
        Navegacao.abrir(Camada.Perfil)
        Navegacao.abrir(Camada.Detalhe("x", "filme", null))
        Navegacao.substituirTopo(Camada.Planos())
        assertEquals(2, Navegacao.pilha.size)
        Navegacao.voltar()
        assertSame(Camada.Perfil, Navegacao.pilha.last())
    }

    @Test
    fun `episodio que pede promocao substitui o player sem crescer a pilha`() {
        Navegacao.abrir(Camada.Detalhe("s1", "serie", null))
        Navegacao.abrir(Camada.Player(pedido))
        val decisao = DecisaoDeReproducao.PromocaoObrigatoria("desafio_1")
        Navegacao.substituirTopo(Camada.Player(pedido.copy(numeroEp = 3), autorizacaoPrevia = decisao))

        assertEquals(2, Navegacao.pilha.size)
        assertEquals(decisao, (Navegacao.pilha.last() as Camada.Player).autorizacaoPrevia)
    }
}
