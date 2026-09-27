package com.obaflix.tv.player

import com.obaflix.tv.catalogo.Concessao
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * O controle de canal da televisao, testado como protocolo — o mesmo que
 * `src/lib/__tests__/canaisHandoff.test.ts` trava no cliente web.
 *
 * O relogio e injetado: `esperar` nao dorme, so avanca o relogio falso. Por isso
 * `runBlocking` basta e nao ha dependencia de `kotlinx-coroutines-test`.
 */
class HandoffDeCanalTest {

    private fun url(n: Int) = "https://cdn.example.test/live/$n/index.m3u8"

    private class Relogio(var t: Long = 1_000_000L)

    private fun controle(
        relogio: Relogio,
        respostas: ArrayDeque<Concessao>,
        pedidos: MutableList<Boolean>,
        fontes: MutableList<String>,
        perdas: MutableList<Concessao>,
    ) = HandoffDeCanal(
        canalId = "canal-1",
        pedir = { _, reresolucao -> pedidos += reresolucao; respostas.removeFirstOrNull() ?: Concessao.FalhaTemporaria },
        trocarFonte = { fontes += it },
        aoPerder = { perdas += it },
        esperar = { relogio.t += it },
        agora = { relogio.t },
    )

    @Test
    fun `abertura usa o contrato atual e troca a fonte pela streamUrl`() = runBlocking {
        val pedidos = mutableListOf<Boolean>(); val fontes = mutableListOf<String>(); val perdas = mutableListOf<Concessao>()
        val c = controle(Relogio(), ArrayDeque(listOf(Concessao.Liberado(url(1)))), pedidos, fontes, perdas)

        c.iniciar()

        assertEquals("abertura nao e re-resolucao", listOf(false), pedidos)
        assertEquals(listOf(url(1)), fontes)
        assertEquals(url(1), c.fonteAtual)
        assertTrue(perdas.isEmpty())
    }

    @Test
    fun `erro de reproducao re-resolve e migra o player para a URL nova`() = runBlocking {
        val pedidos = mutableListOf<Boolean>(); val fontes = mutableListOf<String>(); val perdas = mutableListOf<Concessao>()
        val c = controle(Relogio(), ArrayDeque(listOf(Concessao.Liberado(url(1)), Concessao.Liberado(url(2)))), pedidos, fontes, perdas)

        c.iniciar()
        c.aoErroDeReproducao()

        assertEquals(listOf(false, true), pedidos)
        assertEquals(listOf(url(1), url(2)), fontes)
        assertEquals(1, c.reresolucoes)
    }

    @Test
    fun `recusa definitiva na abertura para e nao toca`() = runBlocking {
        val pedidos = mutableListOf<Boolean>(); val fontes = mutableListOf<String>(); val perdas = mutableListOf<Concessao>()
        val c = controle(Relogio(), ArrayDeque(listOf(Concessao.PrecisaDeUpgrade("premium"))), pedidos, fontes, perdas)

        c.iniciar()
        c.aoErroDeReproducao()

        assertTrue(fontes.isEmpty())
        assertEquals(listOf<Concessao>(Concessao.PrecisaDeUpgrade("premium")), perdas)
        assertEquals("parado nao re-resolve", listOf(false), pedidos)
        assertNull(c.fonteAtual)
    }

    @Test
    fun `falha temporaria espera e tenta de novo, sob o teto`() = runBlocking {
        val relogio = Relogio()
        val pedidos = mutableListOf<Boolean>(); val fontes = mutableListOf<String>(); val perdas = mutableListOf<Concessao>()
        val c = controle(
            relogio,
            ArrayDeque(listOf(Concessao.Liberado(url(1)), Concessao.FalhaTemporaria, Concessao.Liberado(url(2)))),
            pedidos, fontes, perdas,
        )
        c.iniciar()
        val antes = relogio.t

        c.aoErroDeReproducao()

        assertEquals(listOf(url(1), url(2)), fontes)
        assertEquals("esperou 3 s antes de tentar de novo", 3_000L, relogio.t - antes)
        assertTrue(perdas.isEmpty())
    }

    @Test
    fun `teto de 3 re-resolucoes em 60 s encerra, sem laco infinito`() = runBlocking {
        val relogio = Relogio()
        val pedidos = mutableListOf<Boolean>(); val fontes = mutableListOf<String>(); val perdas = mutableListOf<Concessao>()
        // Abre e depois so falha: o canal caiu de vez.
        val c = controle(relogio, ArrayDeque(listOf(Concessao.Liberado(url(1)))), pedidos, fontes, perdas)
        c.iniciar()

        c.aoErroDeReproducao()

        assertEquals(3, c.reresolucoes)
        assertEquals(listOf<Concessao>(Concessao.FalhaTemporaria), perdas)
        // Parado: um erro posterior nao volta a pedir.
        val antes = pedidos.size
        c.aoErroDeReproducao()
        assertEquals(antes, pedidos.size)
    }

    @Test
    fun `janela desliza - live longa pode re-resolver de vez em quando`() = runBlocking {
        val relogio = Relogio()
        val pedidos = mutableListOf<Boolean>(); val fontes = mutableListOf<String>(); val perdas = mutableListOf<Concessao>()
        val respostas = ArrayDeque<Concessao>((1..10).map { Concessao.Liberado(url(it)) })
        val c = controle(relogio, respostas, pedidos, fontes, perdas)
        c.iniciar()

        repeat(6) {
            relogio.t += 25_000 // uma queda a cada 25 s: 2-3 por janela, nunca 4
            c.aoErroDeReproducao()
        }

        assertTrue(perdas.isEmpty())
        assertEquals(6, c.reresolucoes)
    }

    @Test
    fun `single-flight - erros simultaneos disparam um pedido so`() = runBlocking {
        val portao = CompletableDeferred<Unit>()
        var pedidos = 0
        val fontes = mutableListOf<String>()
        val c = HandoffDeCanal(
            canalId = "canal-1",
            pedir = { _, reresolucao ->
                pedidos++
                if (reresolucao) portao.await()
                Concessao.Liberado(url(pedidos))
            },
            trocarFonte = { fontes += it },
            aoPerder = {},
            esperar = {},
        )
        c.iniciar()

        coroutineScope {
            val a = async { c.aoErroDeReproducao() }
            yield()
            val b = async { c.aoErroDeReproducao() }
            val d = async { c.aoErroDeReproducao() }
            yield()
            portao.complete(Unit)
            a.await(); b.await(); d.await()
        }

        assertEquals("1 abertura + 1 re-resolucao", 2, pedidos)
        assertEquals(2, fontes.size)
    }

    @Test
    fun `parar descarta resposta que chega depois`() = runBlocking {
        val portao = CompletableDeferred<Unit>()
        val fontes = mutableListOf<String>()
        val c = HandoffDeCanal(
            canalId = "canal-1",
            pedir = { _, _ -> portao.await(); Concessao.Liberado(url(1)) },
            trocarFonte = { fontes += it },
            aoPerder = {},
            esperar = {},
        )
        coroutineScope {
            val abertura = async { c.iniciar() }
            yield()
            c.parar() // trocou de canal antes da resposta
            portao.complete(Unit)
            abertura.await()
        }
        assertTrue("canal abandonado nao toca", fontes.isEmpty())
    }

    @Test
    fun `watchdog dispara uma vez por stall e rearma apos avanco`() {
        val w = WatchdogDeStall(limiarMs = 7_000)
        w.progrediu(0, 0)
        w.progrediu(1_000, 1_000)
        assertFalse(w.deveReresolver(7_000))
        assertTrue("parado ha 7 s", w.deveReresolver(8_000))
        assertFalse("nao repete no mesmo stall", w.deveReresolver(20_000))
        w.progrediu(2_000, 21_000)
        assertFalse(w.deveReresolver(27_000))
        assertTrue(w.deveReresolver(28_000))
    }

    @Test
    fun `watchdog ignora pausa voluntaria e da carencia ao retomar`() {
        val w = WatchdogDeStall(limiarMs = 7_000)
        w.progrediu(0, 0)
        w.definirPausado(true, 1_000)
        assertFalse(w.deveReresolver(60_000))
        w.definirPausado(false, 60_000)
        assertFalse(w.deveReresolver(66_000))
        assertTrue(w.deveReresolver(67_000))
    }
}
