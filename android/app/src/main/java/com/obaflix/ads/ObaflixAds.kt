package com.obaflix.ads

import android.content.Context

/**
 * Raiz de composicao da publicidade do aplicativo movel.
 *
 * Vive no modulo `:app` de proposito. `ObaflixApp` esta em `:core-extractor`,
 * compartilhado com o `:tv` — colocar qualquer coisa de anuncio la levaria o SDK
 * para a TV, que nao monetiza e nao deve nem conhecer a dependencia.
 *
 * Singleton porque o provedor (SDK inicializado, interstitial carregado)
 * precisa sobreviver a recriacao da Activity. Uma instancia por Activity
 * reinicializaria o SDK e jogaria fora o anuncio ja carregado a cada mudanca de
 * configuracao. So guarda `applicationContext` — nenhuma referencia a Activity.
 *
 * ## O que este objeto NAO faz mais
 *
 * A versao anterior (branch `local/obaflix-current`) trazia junto um
 * `PlaybackAdGate`, uma `SeriesAdFrequencyPolicy` e um `PrefsAdCounterStore`: o
 * aparelho decidia se havia anuncio, e o contador de episodios vivia em
 * `SharedPreferences`. Funcionava como produto e nao serve como autoridade
 * comercial — limpar os dados do app zerava o ciclo, e nada obrigava um cliente
 * modificado a pedir anuncio algum.
 *
 * **A decisao subiu para o servidor.** O que sobrou aqui e o encanamento do SDK,
 * que continua bom: inicializacao idempotente, preload fora do caminho critico e
 * um contrato de `show` que garante callback terminal unica. O nativo agora so
 * exibe quando mandam, e informa o resultado.
 */
object ObaflixAds {

    @Volatile
    private var provedor: InterstitialAdProvider? = null

    /**
     * O provedor do aplicativo. Na primeira chamada constroi; quem inicializa o
     * SDK e [aquecer].
     */
    fun provider(context: Context): InterstitialAdProvider {
        provedor?.let { return it }
        return synchronized(this) {
            provedor ?: UnityInterstitialAdProvider(context.applicationContext).also { provedor = it }
        }
    }

    /**
     * Inicializa o SDK e ja pede o primeiro interstitial.
     *
     * Separado da construcao **de proposito**: construir e barato, mas
     * inicializar o SDK da Unity nao pode ficar no caminho critico do `onCreate`
     * (antes do `loadUrl`), senao atrasa a primeira renderizacao. A Activity
     * chama isto de forma assincrona, depois de disparar o carregamento da
     * pagina. Idempotente: `initialize`/`preload` ja se protegem de repeticao.
     *
     * Aquecer nao decide nada: um assinante simplesmente nunca chega a
     * `mostrarAnuncio`, e o interstitial carregado e descartado sem ser exibido.
     */
    fun aquecer(context: Context) {
        val p = provider(context)
        p.initialize()
        p.preload()
    }

    /** Ponto de injecao para teste. Producao nunca chama. */
    fun substituirProvedorParaTeste(novo: InterstitialAdProvider?) {
        synchronized(this) { provedor = novo }
    }
}
