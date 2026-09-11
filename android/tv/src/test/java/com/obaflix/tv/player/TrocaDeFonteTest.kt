package com.obaflix.tv.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A troca de fonte do Media3 nao pode reiniciar o conteudo.
 *
 * `player.setMediaItem(item)` — a sobrecarga de um argumento — tem
 * `resetPosition = true` por padrao. Usa-la no handoff faria cada renovacao
 * voltar a reproducao para o comeco: numa live, para o inicio do buffer
 * disponivel; num conteudo com linha do tempo, para o zero. A cada ~3 minutos.
 *
 * Estes testes travam o contrato com um dublê, porque ExoPlayer nao instancia
 * fora do Android. O que fica sem cobertura automatica e a ligacao entre
 * `PlayerDeMidia` e o ExoPlayer real — uma linha por membro, em
 * `TelaPlayerDeCanal` — e a continuidade visual, que so um aparelho mostra.
 */
class TrocaDeFonteTest {

    /**
     * Dublê que se comporta como o Media3 no ponto que importa: `setMediaItem`
     * com `resetPosition` zera a posicao, sem ele a mantem.
     */
    private class PlayerFalso(var posicao: Long = 0L) : PlayerDeMidia {
        val urls = mutableListOf<String>()
        val manterPosicaoPorChamada = mutableListOf<Boolean>()
        var preparos = 0
        var itens = 0

        override val posicaoMs: Long get() = posicao
        override val temItem: Boolean get() = itens > 0

        override fun definirFonte(url: String, manterPosicao: Boolean) {
            urls += url
            manterPosicaoPorChamada += manterPosicao
            itens = 1
            // O comportamento real do Media3: resetPosition = !manterPosicao.
            if (!manterPosicao) posicao = 0L
        }

        override fun preparar() {
            preparos++
        }
    }

    /**
     * O teste central: a posicao sobrevive a troca.
     *
     * Simula 42 s de reproducao, troca a fonte, e exige que a posicao continue
     * em 42 s. Com `setMediaItem(item)` de um argumento so, este teste falha.
     */
    @Test
    fun `trocar a fonte nao zera a posicao`() {
        val player = PlayerFalso()
        val troca = TrocaDeFonte(player)

        troca.aplicar("https://media.example.test/canal/s/master.m3u8?e=1&k=a")
        // Carga inicial: nao ha posicao a preservar, e o player comeca do zero.
        assertEquals(0L, player.posicao)
        assertFalse("a primeira carga nao precisa manter posicao", player.manterPosicaoPorChamada[0])

        // Reproduziu 42 s.
        player.posicao = 42_000L

        troca.aplicar("https://media.example.test/canal/s/master.m3u8?e=2&k=b")

        assertTrue("a troca TEM de manter a posicao", player.manterPosicaoPorChamada[1])
        assertEquals("a renovacao nao pode reiniciar o conteudo", 42_000L, player.posicao)
    }

    /** Varias renovacoes seguidas: a posicao nunca volta a zero. */
    @Test
    fun `posicao sobrevive a varias renovacoes`() {
        val player = PlayerFalso()
        val troca = TrocaDeFonte(player)

        troca.aplicar("url-0")
        for (i in 1..5) {
            player.posicao += 180_000L // ~3 min entre renovacoes
            val antes = player.posicao
            troca.aplicar("url-$i")
            assertEquals("renovacao $i zerou a posicao", antes, player.posicao)
        }

        assertEquals(6, troca.aplicadas)
        assertEquals(6, player.preparos)
        assertEquals(listOf("url-0", "url-1", "url-2", "url-3", "url-4", "url-5"), player.urls)
    }

    /** Toda troca prepara: sem `prepare()`, a fonte nova nao chega a carregar. */
    @Test
    fun `toda troca prepara o player`() {
        val player = PlayerFalso()
        val troca = TrocaDeFonte(player)

        troca.aplicar("a")
        assertEquals(1, player.preparos)
        troca.aplicar("b")
        assertEquals(2, player.preparos)
    }
}
