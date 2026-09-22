package com.obaflix.tv.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Autorizacao e sessao promocional na TV.
 *
 * O servidor e a autoridade — `/api/player/fontes` recusa sem credencial. O que
 * se prova aqui e que o aparelho nao cria um caminho proprio para o player:
 * nenhuma resposta de erro, nenhum evento fora de ordem e nenhuma interrupcao
 * levam a `Liberada` sem que o servidor tenha dito `PERMITIDO` ou emitido a
 * concessao.
 */
class AutorizacaoTvTest {

    private val d = "desafio_1"
    private val video = "https://midia.invalido/promo.mp4"

    // ── Respostas ────────────────────────────────────────────────────────────

    @Test
    fun `PERMITIDO libera, com passe ou sem`() {
        assertEquals(DecisaoDeReproducao.Liberada(null), interpretarAutorizacao(200, "PERMITIDO", null, null, null))
        assertEquals(
            DecisaoDeReproducao.Liberada("passe_123"),
            interpretarAutorizacao(200, "PERMITIDO", null, "passe_123", null),
        )
        assertEquals(
            "passe malformado nao vira credencial",
            DecisaoDeReproducao.Liberada(null),
            interpretarAutorizacao(200, "PERMITIDO", null, "../x", null),
        )
    }

    @Test
    fun `promocao exige id de desafio valido`() {
        assertEquals(
            DecisaoDeReproducao.PromocaoObrigatoria("d_abc-123"),
            interpretarAutorizacao(200, "PROMOCAO_TV_NECESSARIA", null, null, "d_abc-123"),
        )
        assertEquals(
            DecisaoDeReproducao.FalhaTemporaria,
            interpretarAutorizacao(200, "PROMOCAO_TV_NECESSARIA", null, null, null),
        )
        assertEquals(
            DecisaoDeReproducao.FalhaTemporaria,
            interpretarAutorizacao(200, "PROMOCAO_TV_NECESSARIA", null, null, "com espaco"),
        )
    }

    @Test
    fun `recusa, erro e decisao desconhecida nunca liberam`() {
        val casos = listOf(
            Triple(200, "NEGADO", "conteudo_indisponivel_no_plano") to DecisaoDeReproducao.ForaDoPlano,
            Triple(200, "ANUNCIO_INDISPONIVEL", "anuncio_indisponivel") to DecisaoDeReproducao.GratuitoIndisponivel,
            Triple(200, "ANUNCIO_NECESSARIO", null) to DecisaoDeReproducao.GratuitoIndisponivel,
            Triple(200, "DECISAO_NOVA", null) to DecisaoDeReproducao.FalhaTemporaria,
            Triple(200, null, null) to DecisaoDeReproducao.FalhaTemporaria,
            Triple(401, null, null) to DecisaoDeReproducao.SemSessao,
            Triple(404, null, null) to DecisaoDeReproducao.ConteudoInexistente,
            Triple(429, null, null) to DecisaoDeReproducao.FalhaTemporaria,
            Triple(503, null, "entitlements_indisponiveis") to DecisaoDeReproducao.FalhaTemporaria,
            Triple(0, null, null) to DecisaoDeReproducao.FalhaTemporaria,
        )
        for ((entrada, esperado) in casos) {
            val decisao = interpretarAutorizacao(entrada.first, entrada.second, entrada.third, "passe_x", "desafio_x")
            assertEquals(entrada.toString(), esperado, decisao)
            assertFalse(entrada.toString(), decisao is DecisaoDeReproducao.Liberada)
        }
    }

    @Test
    fun `inicio da promocao`() {
        assertEquals(InicioDaPromocaoTv.Iniciada(video, 30), interpretarInicio(200, video, 30))
        assertEquals(InicioDaPromocaoTv.FalhaTemporaria, interpretarInicio(200, "http://midia.invalido/x.mp4", 30))
        assertEquals(InicioDaPromocaoTv.FalhaTemporaria, interpretarInicio(200, null, 30))
        assertEquals(InicioDaPromocaoTv.Expirada, interpretarInicio(403, null, null))
        assertEquals(InicioDaPromocaoTv.Expirada, interpretarInicio(404, null, null))
        assertEquals(InicioDaPromocaoTv.SemSessao, interpretarInicio(401, null, null))
        assertEquals(InicioDaPromocaoTv.FalhaTemporaria, interpretarInicio(0, null, null))
        assertEquals(InicioDaPromocaoTv.FalhaTemporaria, interpretarInicio(429, null, null))
    }

    @Test
    fun `conclusao da promocao`() {
        assertEquals(ConclusaoDaPromocao.Concedida("c_1"), interpretarConclusao(200, "c_1"))
        assertEquals(ConclusaoDaPromocao.FalhaTemporaria, interpretarConclusao(200, null))
        assertEquals(ConclusaoDaPromocao.Recusada, interpretarConclusao(403, null))
        assertEquals(ConclusaoDaPromocao.SemSessao, interpretarConclusao(401, null))
        assertEquals(ConclusaoDaPromocao.FalhaTemporaria, interpretarConclusao(0, null))
        assertEquals(ConclusaoDaPromocao.FalhaTemporaria, interpretarConclusao(503, null))
    }

    @Test
    fun `fim real do video`() {
        assertTrue(terminouDeVerdade(30_000, 30_000))
        assertTrue(terminouDeVerdade(28_600, 30_000))
        assertFalse("longe do fim", terminouDeVerdade(20_000, 30_000))
        assertFalse("sem duracao", terminouDeVerdade(0, 0))
        assertFalse("duracao desconhecida", terminouDeVerdade(5_000, -1))
    }

    // ── Etapas ───────────────────────────────────────────────────────────────

    @Test
    fun `assinante vai direto ao player, sem anuncio`() {
        assertEquals(
            EtapaDaReproducao.Liberada(null),
            avancar(EtapaDaReproducao.Autorizando, EventoDaReproducao.Decidiu(DecisaoDeReproducao.Liberada(null))),
        )
    }

    @Test
    fun `gratuito percorre promocao, escolha final e conclusao ate o player`() {
        var e: EtapaDaReproducao = EtapaDaReproducao.Autorizando
        e = avancar(e, EventoDaReproducao.Decidiu(DecisaoDeReproducao.PromocaoObrigatoria(d)))
        assertEquals(EtapaDaReproducao.IniciandoPromocao(d), e)
        e = avancar(e, EventoDaReproducao.PromocaoIniciou(InicioDaPromocaoTv.Iniciada(video, 30)))
        assertEquals(EtapaDaReproducao.Promocao(d, video), e)
        e = avancar(e, EventoDaReproducao.VideoTerminou)
        assertEquals(EtapaDaReproducao.EscolhaFinal(d, video), e)
        e = avancar(e, EventoDaReproducao.EscolheuContinuarGratis)
        assertEquals(EtapaDaReproducao.ConcluindoPromocao(d), e)
        e = avancar(e, EventoDaReproducao.PromocaoConcluiu(ConclusaoDaPromocao.Concedida("c_1")))
        assertEquals(EtapaDaReproducao.Liberada("c_1"), e)
    }

    @Test
    fun `fim de video fora da promocao e ignorado`() {
        val etapas = listOf(
            EtapaDaReproducao.Autorizando,
            EtapaDaReproducao.IniciandoPromocao(d),
            EtapaDaReproducao.EscolhaFinal(d, video),
            EtapaDaReproducao.Falha(MotivoDaFalha.Rede, EtapaDaReproducao.Autorizando),
            EtapaDaReproducao.Saiu,
        )
        etapas.forEach { assertEquals(it.toString(), it, avancar(it, EventoDaReproducao.VideoTerminou)) }
    }

    @Test
    fun `conclusao so vale depois do fim do video`() {
        val concedida = EventoDaReproducao.PromocaoConcluiu(ConclusaoDaPromocao.Concedida("c_1"))
        val antes = listOf(
            EtapaDaReproducao.Autorizando,
            EtapaDaReproducao.IniciandoPromocao(d),
            EtapaDaReproducao.Promocao(d, video),
            EtapaDaReproducao.EscolhaFinal(d, video),
        )
        antes.forEach { assertEquals(it.toString(), it, avancar(it, concedida)) }
    }

    @Test
    fun `voltar durante a promocao cancela a tentativa e sai, nunca libera`() {
        val durante = listOf(
            EtapaDaReproducao.IniciandoPromocao(d),
            EtapaDaReproducao.Promocao(d, video),
            EtapaDaReproducao.EscolhaFinal(d, video),
            EtapaDaReproducao.EscolhaFinal(d, null),
            EtapaDaReproducao.ConcluindoPromocao(d),
        )
        durante.forEach {
            assertEquals(it.toString(), EtapaDaReproducao.Saiu, avancar(it, EventoDaReproducao.Voltou))
        }
    }

    @Test
    fun `voltar nos avisos sai sem prender`() {
        val saidas = listOf(
            EtapaDaReproducao.Autorizando,
            EtapaDaReproducao.Falha(MotivoDaFalha.Rede, EtapaDaReproducao.Autorizando),
            EtapaDaReproducao.ForaDoPlano,
            EtapaDaReproducao.GratuitoIndisponivel,
            EtapaDaReproducao.ConteudoInexistente,
            EtapaDaReproducao.SemSessao,
        )
        saidas.forEach { assertEquals(it.toString(), EtapaDaReproducao.Saiu, avancar(it, EventoDaReproducao.Voltou)) }
    }

    @Test
    fun `falha do video permite tentar de novo o mesmo desafio`() {
        val falha = avancar(EtapaDaReproducao.Promocao(d, video), EventoDaReproducao.VideoFalhou)
        assertEquals(EtapaDaReproducao.Falha(MotivoDaFalha.VideoNaoCarregou, EtapaDaReproducao.IniciandoPromocao(d)), falha)
        assertEquals(EtapaDaReproducao.IniciandoPromocao(d), avancar(falha, EventoDaReproducao.TentouDeNovo))
    }

    @Test
    fun `falha de rede na autorizacao e recuperavel`() {
        val falha = avancar(
            EtapaDaReproducao.Autorizando,
            EventoDaReproducao.Decidiu(DecisaoDeReproducao.FalhaTemporaria),
        )
        assertEquals(EtapaDaReproducao.Falha(MotivoDaFalha.Rede, EtapaDaReproducao.Autorizando), falha)
        assertEquals(EtapaDaReproducao.Autorizando, avancar(falha, EventoDaReproducao.TentouDeNovo))
    }

    @Test
    fun `conclusao recusada ou sem rede nao libera e volta a perguntar`() {
        for (c in listOf(ConclusaoDaPromocao.Recusada, ConclusaoDaPromocao.FalhaTemporaria)) {
            val e = avancar(EtapaDaReproducao.ConcluindoPromocao(d), EventoDaReproducao.PromocaoConcluiu(c))
            assertEquals(c.toString(), EtapaDaReproducao.Falha(MotivoDaFalha.ConclusaoNaoConfirmada, EtapaDaReproducao.Autorizando), e)
        }
    }

    @Test
    fun `inicio expirado volta a autorizar`() {
        assertEquals(
            EtapaDaReproducao.Autorizando,
            avancar(EtapaDaReproducao.IniciandoPromocao(d), EventoDaReproducao.PromocaoIniciou(InicioDaPromocaoTv.Expirada)),
        )
    }

    @Test
    fun `continuar gratis duas vezes nao conclui duas vezes`() {
        val concluindo = EtapaDaReproducao.ConcluindoPromocao(d)
        assertEquals(concluindo, avancar(concluindo, EventoDaReproducao.EscolheuContinuarGratis))
    }

    @Test
    fun `camada com decisao previa comeca no video`() {
        assertEquals(EtapaDaReproducao.IniciandoPromocao(d), etapaInicial(DecisaoDeReproducao.PromocaoObrigatoria(d)))
        assertEquals(EtapaDaReproducao.Autorizando, etapaInicial(null))
    }

    /**
     * Busca exaustiva: a partir de `Autorizando`, com todos os eventos possiveis
     * EXCETO os dois que o servidor usa para liberar — `PERMITIDO` e a
     * concessao —, nenhuma etapa alcancavel e `Liberada`.
     */
    @Test
    fun `sem PERMITIDO e sem concessao nenhuma sequencia chega ao player`() {
        val eventos = listOf(
            EventoDaReproducao.Decidiu(DecisaoDeReproducao.PromocaoObrigatoria(d)),
            EventoDaReproducao.Decidiu(DecisaoDeReproducao.ForaDoPlano),
            EventoDaReproducao.Decidiu(DecisaoDeReproducao.GratuitoIndisponivel),
            EventoDaReproducao.Decidiu(DecisaoDeReproducao.ConteudoInexistente),
            EventoDaReproducao.Decidiu(DecisaoDeReproducao.SemSessao),
            EventoDaReproducao.Decidiu(DecisaoDeReproducao.FalhaTemporaria),
            EventoDaReproducao.EscolheuContinuarGratis,
            EventoDaReproducao.PromocaoIniciou(InicioDaPromocaoTv.Iniciada(video, 30)),
            EventoDaReproducao.PromocaoIniciou(InicioDaPromocaoTv.Expirada),
            EventoDaReproducao.PromocaoIniciou(InicioDaPromocaoTv.SemSessao),
            EventoDaReproducao.PromocaoIniciou(InicioDaPromocaoTv.FalhaTemporaria),
            EventoDaReproducao.VideoTerminou,
            EventoDaReproducao.VideoFalhou,
            EventoDaReproducao.PromocaoConcluiu(ConclusaoDaPromocao.Recusada),
            EventoDaReproducao.PromocaoConcluiu(ConclusaoDaPromocao.SemSessao),
            EventoDaReproducao.PromocaoConcluiu(ConclusaoDaPromocao.FalhaTemporaria),
            EventoDaReproducao.TentouDeNovo,
            EventoDaReproducao.Voltou,
        )
        val vistos = mutableSetOf<EtapaDaReproducao>(EtapaDaReproducao.Autorizando)
        val fila = ArrayDeque<EtapaDaReproducao>().apply { add(EtapaDaReproducao.Autorizando) }
        while (fila.isNotEmpty()) {
            val atual = fila.removeFirst()
            for (evento in eventos) {
                val proxima = avancar(atual, evento)
                if (vistos.add(proxima)) fila.add(proxima)
            }
        }
        assertTrue("a busca percorreu a promocao inteira", EtapaDaReproducao.ConcluindoPromocao(d) in vistos)
        assertTrue("a busca passou pela escolha final", EtapaDaReproducao.EscolhaFinal(d, video) in vistos)
        assertTrue(vistos.none { it is EtapaDaReproducao.Liberada })
    }
}
