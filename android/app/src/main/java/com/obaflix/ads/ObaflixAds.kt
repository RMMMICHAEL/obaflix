package com.obaflix.ads

import android.content.Context

/**
 * Raiz de composicao da publicidade do aplicativo movel.
 *
 * Vive no modulo `:app` de proposito. `ObaflixApp` esta em `:core-extractor`,
 * compartilhado com o `:tv` — colocar qualquer coisa de anuncio la levaria o SDK
 * para a TV, que nao monetiza e nao deve nem conhecer a dependencia.
 *
 * Singleton porque o provedor (SDK inicializado, interstitial carregado) e o
 * ciclo das series precisam sobreviver a recriacao da Activity. Uma instancia
 * por Activity reinicializaria o SDK e jogaria fora o anuncio ja carregado a
 * cada mudanca de configuracao.
 *
 * So guarda `applicationContext` — nenhuma referencia a Activity.
 */
object ObaflixAds {

    @Volatile
    private var instancia: PlaybackAdGate? = null

    /**
     * Ha um interstitial cobrindo a tela agora? Consultado pela Activity no
     * `onPause` para manter a WebView viva durante o anuncio, de modo que o
     * player seja preparado em segundo plano enquanto o anuncio esta aberto.
     * `false` antes do primeiro aquecimento — nunca ha anuncio nesse ponto.
     */
    val anuncioEmExibicao: Boolean
        get() = instancia?.anuncioEmExibicao == true

    /**
     * O [PlaybackAdGate] do aplicativo. Na primeira chamada inicializa o SDK e
     * ja pede o primeiro interstitial, para que ele esteja pronto muito antes de
     * o usuario tocar em ASSISTIR.
     */
    fun gate(context: Context): PlaybackAdGate {
        instancia?.let { return it }
        return synchronized(this) {
            instancia ?: criar(context).also { instancia = it }
        }
    }

    /**
     * Inicializa o SDK e ja pede o primeiro interstitial. Separado de [gate]
     * **de proposito**: construir o gate e barato, mas inicializar o SDK da
     * Unity nao pode ficar no caminho critico do `onCreate` (antes do
     * `loadUrl`), senao atrasa a primeira renderizacao. A Activity chama isto
     * de forma assincrona, depois de disparar o carregamento da pagina.
     * Idempotente: `initialize`/`preload` ja se protegem de repeticao.
     */
    fun aquecer(context: Context) {
        gate(context).aquecer()
    }

    /** A MainActivity ganhou/perdeu foco. No-op se nao ha anuncio em andamento. */
    fun aoMainFoco(focado: Boolean) {
        instancia?.aoMainFoco(focado)
    }

    /** Uma Activity do fluxo do anuncio foi criada por cima da nossa. */
    fun aoOverlayCriado(classe: String) {
        instancia?.aoOverlayCriado(classe)
    }

    fun aoOverlayResumido(classe: String) {
        instancia?.aoOverlayResumido(classe)
    }

    fun aoOverlayPausado(classe: String) {
        instancia?.aoOverlayPausado(classe)
    }

    /** A ultima Activity do anuncio sumiu: fechamento visual real (com foco). */
    fun aoOverlayDestruido(classe: String) {
        instancia?.aoOverlayDestruido(classe)
    }

    /**
     * A Activity host foi destruida com um anuncio em andamento: cancela o hold
     * para nao ficar preso nem reproduzir numa tela morta. No-op se nao ha
     * anuncio em andamento.
     */
    fun aoDestruirHost() {
        instancia?.aoDestruirHost()
    }

    private fun criar(context: Context): PlaybackAdGate {
        val app = context.applicationContext
        return PlaybackAdGate(
            provider = UnityInterstitialAdProvider(app),
            seriesPolicy = SeriesAdFrequencyPolicy(PrefsAdCounterStore(app)),
        )
    }
}
