package com.obaflix.ads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A regra de frequencia isolada, sem gate e sem provedor.
 *
 * Complementa [PlaybackAdGateTest]: la se verifica o comportamento visto pelo
 * usuario; aqui, o contrato do contador — inclusive a persistencia, simulada
 * trocando de instancia sobre o mesmo store (que e o que acontece quando a
 * Activity e recriada e o gate le de novo as SharedPreferences).
 */
class SeriesAdFrequencyPolicyTest {

    private class StoreEmMemoria(override var episodiosNoCiclo: Int = 0) : AdCounterStore

    @Test
    fun `padrao do projeto e dois episodios livres por anuncio`() {
        assertEquals(2, SeriesAdFrequencyPolicy.EPISODIOS_POR_ANUNCIO)
    }

    /**
     * A sequencia inteira, dois ciclos seguidos.
     *
     * O ponto que este teste fixa: o anuncio nao acompanha o segundo episodio —
     * ele e cobrado na intencao **seguinte** aos dois livres.
     */
    @Test
    fun `dois episodios livres e anuncio na proxima intencao, em dois ciclos`() {
        val store = StoreEmMemoria()
        val politica = SeriesAdFrequencyPolicy(store)

        assertFalse("ep 1 sem anuncio", politica.registrarIntencaoDeEpisodio())
        assertEquals(1, store.episodiosNoCiclo)

        assertFalse("ep 2 sem anuncio", politica.registrarIntencaoDeEpisodio())
        assertEquals(2, store.episodiosNoCiclo)

        assertTrue("ep 3 com anuncio", politica.registrarIntencaoDeEpisodio())
        politica.aoConsumirAnuncio() // anuncio exibido e fechado
        assertEquals("ciclo reiniciado", 0, store.episodiosNoCiclo)

        assertFalse("ep 4 sem anuncio", politica.registrarIntencaoDeEpisodio())
        assertEquals(1, store.episodiosNoCiclo)

        assertFalse("ep 5 sem anuncio", politica.registrarIntencaoDeEpisodio())
        assertEquals(2, store.episodiosNoCiclo)

        assertTrue("ep 6 com anuncio", politica.registrarIntencaoDeEpisodio())
    }

    /**
     * Fail-open sem perder o anuncio devido: o ep 3 deveria exibir, mas nao
     * havia inventario (ou houve falha de load/show, ou timeout). A reproducao
     * segue — quem cuida disso e o [PlaybackAdGate] —, o ciclo continua devendo,
     * e o ep 4 tenta de novo.
     */
    @Test
    fun `ep3 sem inventario mantem o devido e ep4 tenta de novo`() {
        val store = StoreEmMemoria()
        val politica = SeriesAdFrequencyPolicy(store)

        politica.registrarIntencaoDeEpisodio() // ep 1
        politica.registrarIntencaoDeEpisodio() // ep 2

        assertTrue("ep 3 devia exibir", politica.registrarIntencaoDeEpisodio())
        // Sem anuncio exibido, ninguem chama aoConsumirAnuncio().
        assertEquals("contador nao avanca nem zera", 2, store.episodiosNoCiclo)

        assertTrue("ep 4 tenta de novo", politica.registrarIntencaoDeEpisodio())
        assertEquals(2, store.episodiosNoCiclo)

        politica.aoConsumirAnuncio() // agora exibiu
        assertEquals(0, store.episodiosNoCiclo)
        assertFalse("ep 5 recomeca a cota livre", politica.registrarIntencaoDeEpisodio())
    }

    @Test
    fun `so aoConsumirAnuncio reinicia o ciclo`() {
        val store = StoreEmMemoria()
        val politica = SeriesAdFrequencyPolicy(store)

        politica.registrarIntencaoDeEpisodio()
        politica.registrarIntencaoDeEpisodio()

        // Varias intencoes devendo, nenhuma exibicao: o estado nao se move.
        repeat(5) {
            assertTrue(politica.registrarIntencaoDeEpisodio())
            assertEquals(2, store.episodiosNoCiclo)
        }

        politica.aoConsumirAnuncio()
        assertEquals(0, store.episodiosNoCiclo)
    }

    @Test
    fun `contador sobrevive a recriacao da UI`() {
        val store = StoreEmMemoria()

        // Duas instancias diferentes, uma por recriacao da tela, mesmo store.
        assertFalse(SeriesAdFrequencyPolicy(store).registrarIntencaoDeEpisodio()) // ep 1
        assertFalse(SeriesAdFrequencyPolicy(store).registrarIntencaoDeEpisodio()) // ep 2
        assertTrue(
            "o ciclo nao pode reiniciar so porque a tela foi recriada",
            SeriesAdFrequencyPolicy(store).registrarIntencaoDeEpisodio(), // ep 3
        )
    }

    @Test
    fun `frequencia e configuravel sem tocar no gate`() {
        val politica = SeriesAdFrequencyPolicy(StoreEmMemoria(), episodiosPorAnuncio = 3)

        assertFalse(politica.registrarIntencaoDeEpisodio())
        assertFalse(politica.registrarIntencaoDeEpisodio())
        assertFalse(politica.registrarIntencaoDeEpisodio())
        assertTrue("anuncio so na quarta intencao", politica.registrarIntencaoDeEpisodio())
    }
}
