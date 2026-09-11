package com.obaflix.tv.player

/**
 * A troca de fonte do player, isolada do Media3 para poder ser testada.
 *
 * ## O que esta classe existe para impedir
 *
 * `player.setMediaItem(item)` **zera a posicao** — e a sobrecarga de um
 * argumento so tem `resetPosition = true` por padrao. Chamar ela no handoff
 * faria cada renovacao reiniciar o conteudo: numa live, voltar para o comeco do
 * buffer disponivel; num conteudo com linha do tempo, voltar para o zero.
 *
 * O certo e `setMediaItem(item, resetPosition = false)`, que mantem a posicao
 * corrente. A URL mudou; o ponto da reproducao, nao.
 *
 * Tambem nao se chama `stop()` nem `clearMediaItems()` antes: os dois descartam
 * o estado que se quer preservar, e `setMediaItem` ja substitui a fila sozinho.
 *
 * ## Por que uma interface em vez do ExoPlayer direto
 *
 * ExoPlayer nao instancia fora do Android, entao um teste JVM nao consegue
 * segurar um de verdade. `PlayerDeMidia` tem exatamente os quatro membros que a
 * troca usa, `TrocaDeFonte` fala so com eles, e `TrocaDeFonteTest` prova o
 * contrato com um dublê. O que sobra sem cobertura e a ligacao entre a
 * interface e o ExoPlayer real — uma linha por membro, em `TelaPlayerDeCanal`.
 */
interface PlayerDeMidia {
    /** Posicao corrente, em ms. */
    val posicaoMs: Long

    /** `true` quando ha um item carregado — ou seja, quando nao e a 1a troca. */
    val temItem: Boolean

    /**
     * Substitui a fonte.
     *
     * @param manterPosicao `false` **so** na primeira carga. Em qualquer troca
     *   seguinte tem de ser `true`, senao a renovacao reinicia o conteudo.
     */
    fun definirFonte(url: String, manterPosicao: Boolean)

    fun preparar()
}

/**
 * Aplica uma URL nova ao player preservando a reproducao.
 *
 * A primeira carga nao tem posicao a manter (o player esta vazio); as seguintes
 * tem, e e nelas que o handoff acontece.
 */
class TrocaDeFonte(private val player: PlayerDeMidia) {

    /** Quantas trocas ja aconteceram. A primeira e a carga inicial. */
    var aplicadas: Int = 0
        private set

    fun aplicar(url: String) {
        // `temItem` distingue a carga inicial da troca: so a partir da segunda
        // existe posicao para preservar.
        val manterPosicao = player.temItem
        player.definirFonte(url, manterPosicao)
        player.preparar()
        aplicadas++
    }
}
