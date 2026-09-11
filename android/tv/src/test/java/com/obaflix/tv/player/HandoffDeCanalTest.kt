package com.obaflix.tv.player

import com.obaflix.tv.catalogo.Concessao
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
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
        geracao = n,
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

    // ── Concorrencia e ordem de chegada ──────────────────────────────────────

    /**
     * O caso que a revisao pediu: geracao mais nova chega primeiro, e depois
     * chega uma antiga.
     *
     * Sem a guarda monotonica, o aparelho adotaria a ultima a chegar e
     * REGREDIRIA para uma geracao que o servidor ja aposentou — cuja URL morre
     * na grace seguinte, com o 403 aparecendo minutos depois, longe da causa.
     */
    @Test
    fun `resposta atrasada nao faz a geracao regredir`() = runBlocking {
        val fontes = mutableListOf<String>()
        // Ordem de CHEGADA: primeiro a inicial, depois a geracao 3, depois a 2.
        val respostas = ArrayDeque(listOf(liberado(1), liberado(3), liberado(2)))

        val handoff = HandoffDeCanal(
            canalId = "canal-1",
            pedir = { _, _ -> respostas.removeFirst() },
            trocarFonte = { fontes += it },
            aoPerder = {},
            esperar = {},
        )

        handoff.renovarAgora() // sem concessao ainda: nao faz nada
        handoff.executarPrimeira()
        assertEquals(1, handoff.atual!!.geracao)

        handoff.renovarAgora()
        assertEquals("a geracao 3 tem de ser adotada", 3, handoff.atual!!.geracao)

        handoff.renovarAgora() // chega a geracao 2, atrasada
        assertEquals("nao pode voltar para a 2", 3, handoff.atual!!.geracao)
        assertEquals(1, handoff.recusasPorRegressao)

        // A fonte do player nao pode ter sido trocada pela atrasada.
        assertEquals(2, fontes.size)
        assertEquals(2, handoff.trocas)
        assertTrue(fontes.last().contains("e=3"))
    }

    /** A mesma geracao chegando de novo tambem nao troca a fonte. */
    @Test
    fun `geracao repetida nao conta como troca`() = runBlocking {
        val fontes = mutableListOf<String>()
        val respostas = ArrayDeque(listOf(liberado(1), liberado(2), liberado(2)))

        val handoff = HandoffDeCanal(
            canalId = "canal-1",
            pedir = { _, _ -> respostas.removeFirst() },
            trocarFonte = { fontes += it },
            aoPerder = {},
            esperar = {},
        )
        handoff.executarPrimeira()
        handoff.renovarAgora()
        handoff.renovarAgora()

        assertEquals(2, handoff.atual!!.geracao)
        assertEquals(2, fontes.size)
        assertEquals(1, handoff.recusasPorRegressao)
    }

    /**
     * Single-flight: tres renovacoes disparadas juntas gastam UM pedido.
     *
     * Sem isso, o ciclo somado a uma retomada de rede giraria o nonce tres vezes
     * a toa — e cada giro encurta a vida da geracao anterior.
     */
    @Test
    fun `renovacoes simultaneas gastam um pedido so`() = runBlocking {
        var pedidos = 0
        val portao = CompletableDeferred<Unit>()
        val fontes = mutableListOf<String>()

        val handoff = HandoffDeCanal(
            canalId = "canal-1",
            pedir = { _, sessionId ->
                pedidos++
                // A primeira renovacao fica presa ate o portao abrir; as outras
                // chegam enquanto ela esta em voo.
                if (sessionId != null) portao.await()
                liberado(pedidos)
            },
            trocarFonte = { fontes += it },
            aoPerder = {},
            esperar = {},
        )

        handoff.executarPrimeira()
        assertEquals(1, pedidos)

        coroutineScope {
            val a = async { handoff.renovarAgora() }
            val b = async { handoff.renovarAgora() }
            val c = async { handoff.renovarAgora() }
            // `async` so agenda; os corpos rodam quando esta corrotina suspende.
            // Sem o `yield`, o portao abriria antes de qualquer uma comecar, e
            // as tres rodariam em sequencia — o teste passaria sem concorrencia
            // nenhuma, que e o oposto do que ele existe para provar.
            yield()
            portao.complete(Unit)
            a.await(); b.await(); c.await()
        }

        // Uma renovacao de verdade. As outras duas esperaram a mesma.
        assertEquals("tres chamadas, um pedido", 2, pedidos)
        assertEquals(2, handoff.trocas)
        assertEquals(2, fontes.size)
    }
}
