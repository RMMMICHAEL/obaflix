package com.obaflix.ads

/**
 * Onde o contador de episodios vive.
 *
 * Interface para que a politica seja testavel sem Android; a implementacao real
 * e [PrefsAdCounterStore].
 */
interface AdCounterStore {
    var episodiosNoCiclo: Int
}

/**
 * Regra de frequencia das series: um anuncio a cada [episodiosPorAnuncio]
 * intencoes reais de iniciar episodio.
 *
 * A regra mora aqui inteira, e nao espalhada pela UI, porque "o que conta como
 * intencao" e a parte delicada. Quem chama [registrarIntencaoDeEpisodio] e
 * apenas o [PlaybackAdGate], e apenas quando o usuario toca de fato para abrir
 * um episodio. Nao contam — e portanto nunca chegam aqui — retentativa interna,
 * buffering, retomada, reconexao, erro de player, troca de servidor, failover
 * automatico, re-resolucao de fonte, rotacao da tela ou recriacao da Activity.
 *
 * Ciclo com o padrao de 2: [episodiosPorAnuncio] episodios passam livres, e o
 * anuncio e cobrado na **proxima** intencao depois deles — nao junto com o
 * ultimo episodio livre. Comecando em 0:
 *
 *   ep 1 -> conta 1, segue        ep 4 -> conta 1, segue
 *   ep 2 -> conta 2, segue        ep 5 -> conta 2, segue
 *   ep 3 -> devendo, ANUNCIO      ep 6 -> devendo, ANUNCIO
 *          exibiu? conta volta a 0
 *
 * Se o ciclo esta devendo mas nao havia anuncio carregado — ou houve falha de
 * load/show, timeout, ou qualquer outro fail-open —, o contador **nao** avanca
 * nem zera: continua devendo, e a proxima intencao real de episodio tenta de
 * novo. Quem zera e [aoConsumirAnuncio], chamada so quando o anuncio de fato
 * apareceu e foi fechado. Sem isso, uma falta de inventario empurraria o
 * proximo anuncio para muito depois.
 */
class SeriesAdFrequencyPolicy(
    private val store: AdCounterStore,
    private val episodiosPorAnuncio: Int = EPISODIOS_POR_ANUNCIO,
) {

    companion object {
        /** Um anuncio a cada 2 episodios. */
        const val EPISODIOS_POR_ANUNCIO = 2
    }

    /**
     * Registra uma intencao real de iniciar episodio.
     *
     * @return `true` quando esta intencao deve passar pelo interstitial.
     */
    fun registrarIntencaoDeEpisodio(): Boolean {
        val atual = store.episodiosNoCiclo
        if (atual >= episodiosPorAnuncio) {
            // Cota de episodios livres ja gasta: esta intencao e a que paga.
            // O contador nao avanca — enquanto o anuncio nao aparecer de fato,
            // o ciclo continua devendo e a proxima intencao tenta de novo.
            return true
        }
        // Ainda dentro da cota livre: consome um episodio e segue sem anuncio.
        store.episodiosNoCiclo = atual + 1
        return false
    }

    /** Reinicia o ciclo. So depois de um anuncio ter aparecido de verdade. */
    fun aoConsumirAnuncio() {
        store.episodiosNoCiclo = 0
    }
}
