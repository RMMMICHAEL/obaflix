package com.obaflix.tv.player

import com.obaflix.tv.catalogo.Concessao
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O protocolo de handoff da televisao, testado como protocolo.
 *
 * O que estes testes travam nao e a assinatura nem o HMAC — e a unica coisa que
 * o servidor nao consegue garantir sozinho: que a TV **realmente migra** o
 * player para a concessao nova, dentro da janela em que a anterior ainda vale.
 *
 * Sem isso, girar o nonce numa renovacao mata a reproducao em curso, que foi
 * exatamente o defeito encontrado na revisao.
 *
 * O relogio e injetado: `esperar` nao dorme, so registra quanto teria dormido.
 * Por isso `runBlocking` basta e nao ha dependencia de `kotlinx-coroutines-test`
 * — os testes rodam instantaneos e ainda assim verificam o tempo.
 */
class HandoffDeCanalTest {

    private fun liberado(n: Int, validoPorSegundos: Int = 300) = Concessao.Liberado(
        manifestUrl = "https://media.example.test/canal/sid/master.m3u8?e=$n&k=sig$n",
        sessionId = "sessao-1",
        expiraEm = 0L,
        validoPorSegundos = validoPorSegundos,
    )

    /**
     * O caminho completo: A vira B vira C, e cada troca leva o player junto.
     *
     * `fontes` e o que o ExoPlayer receberia em `setMediaItem`. A asserção que
     * importa e que ele muda a cada renovacao — guardar a URL numa variavel
     * passaria em qualquer teste de assinatura e falharia aqui.
     */
    @Test
    fun `migra o player a cada renovacao`() = runBlocking {
        val fontes = mutableListOf<String>()
        val esperas = mutableListOf<Long>()
        var pedidos = 0
        val sessoesEnviadas = mutableListOf<String?>()

        val handoff = HandoffDeCanal(
            canalId = "canal-1",
            pedir = { _, sessionId ->
                sessoesEnviadas += sessionId
                pedidos++
                if (pedidos <= 3) liberado(pedidos) else Concessao.Indisponivel
            },
            trocarFonte = { fontes += it },
            aoPerder = {},
            esperar = { esperas += it },
        )

        handoff.executar()

        assertEquals(3, handoff.trocas)
        assertEquals(3, fontes.size)
        assertNotEquals("a fonte precisa mudar na renovacao", fontes[0], fontes[1])
        assertNotEquals(fontes[1], fontes[2])
        assertEquals(fontes.last(), handoff.atual!!.manifestUrl)

        // A primeira chamada resolve do zero; as seguintes renovam mandando a
        // sessao — e renovar e o que evita voltar ao provedor.
        assertEquals(listOf(null, "sessao-1", "sessao-1", "sessao-1"), sessoesEnviadas)
    }

    /**
     * A troca acontece **antes** de a concessao anterior vencer.
     *
     * Com 300 s de validade e fracao 0.6, a renovacao cai em 180 s — 120 s de
     * folga. Renovar na borda deixaria o handoff dependendo so da grace do
     * servidor, que e rede de seguranca e nao mecanismo.
     */
    @Test
    fun `renova bem antes do vencimento`() = runBlocking {
        val esperas = mutableListOf<Long>()
        var pedidos = 0

        HandoffDeCanal(
            canalId = "canal-1",
            pedir = { _, _ ->
                pedidos++
                if (pedidos <= 2) liberado(pedidos, validoPorSegundos = 300) else Concessao.Indisponivel
            },
            trocarFonte = {},
            aoPerder = {},
            esperar = { esperas += it },
        ).executar()

        assertEquals(180_000L, esperas.first())
        assertTrue("a renovacao tem de caber com folga", esperas.first() < 300_000L)
    }

    /** Validade curta demais nao pode virar laco de renovacao contra o backend. */
    @Test
    fun `o atraso tem piso`() {
        assertEquals(180_000L, HandoffDeCanal.atrasoDeRenovacaoMs(300))
        assertEquals(30_000L, HandoffDeCanal.atrasoDeRenovacaoMs(10))
        assertEquals(30_000L, HandoffDeCanal.atrasoDeRenovacaoMs(0))
    }

    /**
     * Falha passageira nao troca a fonte e nao derruba a reproducao: o video
     * segue pela concessao atual, e uma nova tentativa cabe antes de ela vencer.
     */
    @Test
    fun `falha temporaria mantem a concessao atual`() = runBlocking {
        val fontes = mutableListOf<String>()
        val esperas = mutableListOf<Long>()
        var perdeu = false
        val respostas = listOf(
            liberado(1),
            Concessao.FalhaTemporaria,
            liberado(2),
            Concessao.Indisponivel,
        )
        var i = 0

        val handoff = HandoffDeCanal(
            canalId = "canal-1",
            pedir = { _, _ -> respostas[i++] },
            trocarFonte = { fontes += it },
            aoPerder = { perdeu = true },
            esperar = { esperas += it },
        )
        handoff.executar()

        // Duas concessoes boas, duas trocas. A falha do meio nao trocou nada.
        assertEquals(2, handoff.trocas)
        assertEquals(2, fontes.size)
        assertTrue("a falha temporaria tem de esperar antes de tentar de novo", esperas.contains(30_000L))
        assertTrue("Indisponivel e definitivo", perdeu)
    }

    /**
     * Recusa definitiva para o ciclo na hora e avisa a tela. Insistir nao traz
     * de volta: a sessao no servidor ja morreu.
     */
    @Test
    fun `recusa definitiva encerra o ciclo`() = runBlocking {
        for (definitiva in listOf(
            Concessao.PrecisaDeUpgrade("premium"),
            Concessao.SemSessao,
            Concessao.Indisponivel,
        )) {
            var perdida: Concessao? = null
            var pedidos = 0
            val handoff = HandoffDeCanal(
                canalId = "canal-1",
                pedir = { _, _ ->
                    pedidos++
                    if (pedidos == 1) liberado(1) else definitiva
                },
                trocarFonte = {},
                aoPerder = { perdida = it },
                esperar = {},
            )
            handoff.executar()

            assertEquals(definitiva, perdida)
            // Uma troca so: a da concessao inicial. A recusa nao troca fonte.
            assertEquals(1, handoff.trocas)
            assertEquals(2, pedidos)
        }
    }

    /** Recusa ja na primeira concessao nunca chega a tocar. */
    @Test
    fun `recusa inicial nao troca fonte nenhuma`() = runBlocking {
        var perdida: Concessao? = null
        val handoff = HandoffDeCanal(
            canalId = "canal-1",
            pedir = { _, _ -> Concessao.PrecisaDeUpgrade("plus") },
            trocarFonte = { throw AssertionError("nao devia trocar fonte") },
            aoPerder = { perdida = it },
            esperar = {},
        )
        handoff.executar()

        assertEquals(0, handoff.trocas)
        assertTrue(perdida is Concessao.PrecisaDeUpgrade)
    }
}
