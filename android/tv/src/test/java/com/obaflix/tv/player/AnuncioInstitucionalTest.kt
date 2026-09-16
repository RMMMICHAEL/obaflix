package com.obaflix.tv.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O anuncio institucional antes de todo filme e episodio de conta gratuita, e a
 * escolha final sobre o ultimo quadro.
 *
 * O que se trava aqui: o fim do video nunca libera sozinho, abrir planos nunca
 * conclui, e so "Continuar gratis" depois do fim chega a conclusao — que ainda
 * depende da concessao do servidor para abrir o player.
 */
class AnuncioInstitucionalTest {

    private val d = "desafio_1"
    private val video = "https://midia.invalido/anuncio.mp4"

    private val filme = Pedido(conteudoId = "f1", conteudoTipo = "filme", titulo = "Filme", backdrop = null)
    private val episodio = filme.copy(conteudoId = "s1", conteudoTipo = "serie", temporada = 1, numeroEp = 2)

    private fun ateEscolhaFinal(inicial: EtapaDaReproducao): EtapaDaReproducao {
        var e = avancar(inicial, EventoDaReproducao.Decidiu(DecisaoDeReproducao.PromocaoObrigatoria(d)))
        e = avancar(e, EventoDaReproducao.PromocaoIniciou(InicioDaPromocaoTv.Iniciada(video, 11)))
        return avancar(e, EventoDaReproducao.VideoTerminou)
    }

    // ── Entrada ──────────────────────────────────────────────────────────────

    @Test
    fun `gratuito sempre entra no anuncio, em filme e em episodio`() {
        // A maquina nao olha o tipo do conteudo: filme e episodio seguem o mesmo
        // caminho. Cada inicio e uma camada nova, que comeca perguntando.
        for (pedido in listOf(filme, episodio)) {
            val camada = com.obaflix.tv.navegacao.Camada.Player(pedido)
            val inicial = etapaInicial(camada.autorizacaoPrevia, camada.memoria.escolhaPendente)
            assertEquals(pedido.conteudoTipo, EtapaDaReproducao.Autorizando, inicial)
            val decidida = avancar(inicial, EventoDaReproducao.Decidiu(DecisaoDeReproducao.PromocaoObrigatoria(d)))
            assertEquals(pedido.conteudoTipo, EtapaDaReproducao.IniciandoPromocao(d), decidida)
        }
    }

    @Test
    fun `episodio seguinte com decisao previa entra direto no anuncio`() {
        val previa = DecisaoDeReproducao.PromocaoObrigatoria(d)
        assertEquals(EtapaDaReproducao.IniciandoPromocao(d), etapaInicial(previa))
    }

    @Test
    fun `episodio iniciado manualmente comeca do zero e entra no anuncio`() {
        // Uma camada nova por episodio: nada da escolha de um episodio anterior
        // (outra camada, outra memoria) pula o video do seguinte.
        val anterior = com.obaflix.tv.navegacao.Camada.Player(episodio)
        anterior.memoria.escolhaPendente = "desafio_antigo"
        val proximo = com.obaflix.tv.navegacao.Camada.Player(episodio.copy(numeroEp = 3))
        assertEquals(EtapaDaReproducao.Autorizando, etapaInicial(proximo.autorizacaoPrevia, proximo.memoria.escolhaPendente))
        assertEquals(EtapaDaReproducao.EscolhaFinal(d, video), ateEscolhaFinal(EtapaDaReproducao.Autorizando))
    }

    @Test
    fun `assinante nao entra no anuncio`() {
        val e = avancar(EtapaDaReproducao.Autorizando, EventoDaReproducao.Decidiu(DecisaoDeReproducao.Liberada(null)))
        assertEquals(EtapaDaReproducao.Liberada(null), e)
    }

    // ── Fim do video ─────────────────────────────────────────────────────────

    @Test
    fun `fim do video nao libera automaticamente`() {
        val fim = ateEscolhaFinal(EtapaDaReproducao.Autorizando)
        assertEquals(EtapaDaReproducao.EscolhaFinal(d, video), fim)
        assertFalse(fim is EtapaDaReproducao.Liberada)
        assertFalse(fim is EtapaDaReproducao.ConcluindoPromocao)
        // Nem um segundo fim, nem uma concessao perdida, tiram da escolha.
        assertEquals(fim, avancar(fim, EventoDaReproducao.VideoTerminou))
        assertEquals(fim, avancar(fim, EventoDaReproducao.PromocaoConcluiu(ConclusaoDaPromocao.Concedida("c_1"))))
        assertEquals(fim, avancar(fim, EventoDaReproducao.VideoFalhou))
    }

    @Test
    fun `continuar gratis depois do fim conclui e libera com a concessao`() {
        var e = ateEscolhaFinal(EtapaDaReproducao.Autorizando)
        assertEquals(AcaoDaEscolha.ContinuarGratis, acaoDoOk(AlvoDaEscolha.ContinuarGratis))
        e = avancar(e, EventoDaReproducao.EscolheuContinuarGratis)
        assertEquals(EtapaDaReproducao.ConcluindoPromocao(d), e)
        e = avancar(e, EventoDaReproducao.PromocaoConcluiu(ConclusaoDaPromocao.Concedida("c_1")))
        assertEquals(EtapaDaReproducao.Liberada("c_1"), e)
    }

    @Test
    fun `continuar gratis antes do fim nao faz nada`() {
        val antes = listOf(
            EtapaDaReproducao.Autorizando,
            EtapaDaReproducao.IniciandoPromocao(d),
            EtapaDaReproducao.Promocao(d, video),
            EtapaDaReproducao.Falha(MotivoDaFalha.VideoNaoCarregou, EtapaDaReproducao.IniciandoPromocao(d)),
        )
        antes.forEach { assertEquals(it.toString(), it, avancar(it, EventoDaReproducao.EscolheuContinuarGratis)) }
    }

    @Test
    fun `conclusao recusada depois de continuar gratis nao libera`() {
        val concluindo = avancar(ateEscolhaFinal(EtapaDaReproducao.Autorizando), EventoDaReproducao.EscolheuContinuarGratis)
        for (c in listOf(ConclusaoDaPromocao.Recusada, ConclusaoDaPromocao.FalhaTemporaria)) {
            assertFalse(c.toString(), avancar(concluindo, EventoDaReproducao.PromocaoConcluiu(c)) is EtapaDaReproducao.Liberada)
        }
    }

    // ── Erro ou saida antes do fim ───────────────────────────────────────────

    @Test
    fun `erro ou saida antes do fim nao libera`() {
        val promocao = EtapaDaReproducao.Promocao(d, video)
        val erro = avancar(promocao, EventoDaReproducao.VideoFalhou)
        assertTrue(erro is EtapaDaReproducao.Falha)
        assertEquals(erro, avancar(erro, EventoDaReproducao.EscolheuContinuarGratis))

        for (etapa in listOf(EtapaDaReproducao.IniciandoPromocao(d), promocao)) {
            assertEquals(etapa.toString(), EtapaDaReproducao.Saiu, avancar(etapa, EventoDaReproducao.Voltou))
        }
        assertEquals(EtapaDaReproducao.Saiu, avancar(EtapaDaReproducao.Saiu, EventoDaReproducao.EscolheuContinuarGratis))
        assertEquals(EtapaDaReproducao.Saiu, avancar(EtapaDaReproducao.Saiu, EventoDaReproducao.VideoTerminou))
    }

    @Test
    fun `voltar na escolha final cancela sem liberar`() {
        val fim = ateEscolhaFinal(EtapaDaReproducao.Autorizando)
        assertEquals(EtapaDaReproducao.Saiu, avancar(fim, EventoDaReproducao.Voltou))
    }

    // ── Planos ───────────────────────────────────────────────────────────────

    @Test
    fun `plano abre Planos sem concluir o anuncio`() {
        assertEquals(AcaoDaEscolha.AbrirPlanos(0), acaoDoOk(AlvoDaEscolha.Basico))
        assertEquals(AcaoDaEscolha.AbrirPlanos(1), acaoDoOk(AlvoDaEscolha.Plus))
        assertEquals(AcaoDaEscolha.AbrirPlanos(2), acaoDoOk(AlvoDaEscolha.Premium))
    }

    @Test
    fun `volta dos planos retoma a escolha do mesmo desafio, sem video e sem liberar`() {
        val retomada = etapaInicial(previa = null, escolhaPendente = d)
        assertEquals(EtapaDaReproducao.EscolhaFinal(d, null), retomada)
        assertEquals(
            EtapaDaReproducao.ConcluindoPromocao(d),
            avancar(retomada, EventoDaReproducao.EscolheuContinuarGratis),
        )
    }

    // ── D-pad ────────────────────────────────────────────────────────────────

    @Test
    fun `foco inicial em Basico`() {
        assertEquals(AlvoDaEscolha.Basico, FOCO_INICIAL_DA_ESCOLHA)
    }

    @Test
    fun `RIGHT e LEFT entre os tres planos, parando nas pontas`() {
        val direita = DirecaoDpad.Direita
        val esquerda = DirecaoDpad.Esquerda
        assertEquals(AlvoDaEscolha.Plus, vizinhoNaEscolha(AlvoDaEscolha.Basico, direita, null))
        assertEquals(AlvoDaEscolha.Premium, vizinhoNaEscolha(AlvoDaEscolha.Plus, direita, null))
        assertEquals(AlvoDaEscolha.Premium, vizinhoNaEscolha(AlvoDaEscolha.Premium, direita, null))
        assertEquals(AlvoDaEscolha.Plus, vizinhoNaEscolha(AlvoDaEscolha.Premium, esquerda, null))
        assertEquals(AlvoDaEscolha.Basico, vizinhoNaEscolha(AlvoDaEscolha.Plus, esquerda, null))
        assertEquals(AlvoDaEscolha.Basico, vizinhoNaEscolha(AlvoDaEscolha.Basico, esquerda, null))
    }

    @Test
    fun `DOWN de qualquer plano vai para Continuar gratis`() {
        listOf(AlvoDaEscolha.Basico, AlvoDaEscolha.Plus, AlvoDaEscolha.Premium).forEach {
            assertEquals(it.name, AlvoDaEscolha.ContinuarGratis, vizinhoNaEscolha(it, DirecaoDpad.Baixo, it))
            assertEquals(it.name, it, vizinhoNaEscolha(it, DirecaoDpad.Cima, it))
        }
    }

    @Test
    fun `UP em Continuar gratis volta ao ultimo plano, ou Basico sem memoria`() {
        val continuar = AlvoDaEscolha.ContinuarGratis
        assertEquals(AlvoDaEscolha.Premium, vizinhoNaEscolha(continuar, DirecaoDpad.Cima, AlvoDaEscolha.Premium))
        assertEquals(AlvoDaEscolha.Plus, vizinhoNaEscolha(continuar, DirecaoDpad.Cima, AlvoDaEscolha.Plus))
        assertEquals(AlvoDaEscolha.Basico, vizinhoNaEscolha(continuar, DirecaoDpad.Cima, null))
        assertEquals(AlvoDaEscolha.Basico, vizinhoNaEscolha(continuar, DirecaoDpad.Cima, continuar))
        for (lado in listOf(DirecaoDpad.Esquerda, DirecaoDpad.Direita, DirecaoDpad.Baixo)) {
            assertEquals(lado.name, continuar, vizinhoNaEscolha(continuar, lado, AlvoDaEscolha.Plus))
        }
    }
}
