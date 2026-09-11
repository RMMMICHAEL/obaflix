package com.obaflix.tv.player

import com.obaflix.tv.catalogo.Concessao

/**
 * O protocolo de handoff entre concessoes, do lado da televisao.
 *
 * Classe pura: sem Compose, sem Media3, sem corrotina propria. Tudo que toca o
 * mundo entra por parametro. Existe assim para poder ser **testada como
 * protocolo** (`HandoffDeCanalTest`), e nao so pela funcao de assinatura — o
 * erro que motivou este arquivo foi exatamente um protocolo correto no servidor
 * e ausente no cliente.
 *
 * Espelha `src/lib/canais/handoff.ts`. Comportamento observavel igual; o codigo
 * nao precisa ser.
 *
 * ## O erro que isto conserta
 *
 * A concessao vale poucos minutos. Renovar gira o nonce da sessao, e o edge
 * valida toda URL com o nonce corrente. Na versao anterior, a TV guardava a
 * `manifestUrl` nova numa variavel e **continuava tocando pela antiga** — que,
 * passada a janela de grace do servidor, deixa de conferir. O ExoPlayer levava
 * 403 no meio da reproducao.
 *
 * Guardar a URL nao e migrar. Migrar e trocar o `MediaItem`, e e isso que
 * `trocarFonte` faz.
 *
 * ## A linha do tempo
 *
 * ```text
 * t=0        concessao A, player tocando por A
 * t=0.6·V    renova  ──► servidor gira o nonce, A entra em grace (60 s)
 * t=0.6·V    trocarFonte(B)  ──► player passa a buscar por B
 * t=0.6·V+g  A morre
 * ```
 *
 * Renova bem antes de vencer por dois motivos somados: dar espaco para uma
 * segunda tentativa, e trocar no meio da janela em que as duas geracoes
 * convivem, nunca na borda.
 */
class HandoffDeCanal(
    private val canalId: String,
    /** `sessionId` presente renova; ausente resolve do zero. */
    private val pedir: suspend (canalId: String, sessionId: String?) -> Concessao,
    /**
     * Faz o player realmente passar a usar esta URL: `setMediaItem` +
     * `prepare`. Nao pode ser "guardar numa variavel" — e essa confusao que
     * esta classe existe para impedir.
     */
    private val trocarFonte: (manifestUrl: String) -> Unit,
    /** Recusa definitiva: a reproducao para e a tela explica. */
    private val aoPerder: (Concessao) -> Unit,
    /** `delay` injetavel, para o teste controlar o relogio. */
    private val esperar: suspend (millis: Long) -> Unit,
    private val fracaoDeRenovacao: Double = 0.6,
    private val esperaAposFalhaS: Int = 30,
) {

    var atual: Concessao.Liberado? = null
        private set

    /** Quantas vezes a fonte do player foi efetivamente trocada. */
    var trocas: Int = 0
        private set

    /**
     * Adota uma concessao: guarda **e** troca a fonte, nesta ordem e sempre
     * juntas. Separar as duas e o bug que esta classe conserta, entao elas nao
     * tem caminho separado.
     */
    private fun adotar(nova: Concessao.Liberado) {
        atual = nova
        trocas++
        trocarFonte(nova.manifestUrl)
    }

    /**
     * Roda o ciclo ate uma recusa definitiva ou ate a corrotina ser cancelada.
     *
     * Quem chama e um `LaunchedEffect`: sair da tela cancela, e o ciclo morre
     * junto.
     */
    suspend fun executar() {
        when (val primeira = pedir(canalId, null)) {
            is Concessao.Liberado -> adotar(primeira)
            else -> {
                aoPerder(primeira)
                return
            }
        }

        while (true) {
            val emUso = atual ?: return
            esperar(atrasoDeRenovacaoMs(emUso.validoPorSegundos, fracaoDeRenovacao))

            when (val nova = pedir(canalId, emUso.sessionId)) {
                is Concessao.Liberado -> adotar(nova)

                // Passageiro: o video segue pela concessao atual ate vencer, e
                // uma nova tentativa cabe antes disso. Nao troca a fonte — nao
                // ha fonte nova.
                is Concessao.FalhaTemporaria -> esperar(esperaAposFalhaS * 1000L)

                // Plano caiu, canal saiu do ar, sessao revogada. Parar e a
                // resposta certa: insistir nao traz de volta, e a sessao no
                // servidor ja morreu.
                else -> {
                    aoPerder(nova)
                    return
                }
            }
        }
    }

    companion object {
        /**
         * Atraso ate a proxima renovacao.
         *
         * O piso de 30 s impede que uma validade absurdamente curta
         * (configuracao errada, relogio torto) vire um laco de renovacao contra
         * o backend.
         */
        fun atrasoDeRenovacaoMs(validoPorSegundos: Int, fracao: Double = 0.6): Long {
            val segundos = (validoPorSegundos * fracao).toInt()
            return maxOf(30, segundos) * 1000L
        }
    }
}
