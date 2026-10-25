package com.nuvio.app.integration.obaflix.ads

// Copied from Obaflix android/app/src/main/java/com/obaflix/ads (origin/main); only package, BuildConfig and log adapted.

import android.content.Context
import com.nuvio.app.integration.obaflix.ObaflixAdEligibility
import kotlinx.coroutines.flow.first

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
            provedor ?: criarProvedor(context.applicationContext).also { provedor = it }
        }
    }

    private fun criarProvedor(context: Context): InterstitialAdProvider =
        // With the S2S Rewarded on (DEBUG against the Preview) LevelPlay is the one that initializes the Unity SDK, and the
        // direct SDK's own `load` then fails with INTERNAL_ERROR (seen on the S9+). One initializer: the Interstitial goes
        // through LevelPlay too. Everywhere else (release, a debug build without Preview) the direct provider stays as is.
        if (ObaflixAdsConfig.INTERSTITIAL_VIA_LEVELPLAY || ObaflixAdsConfig.rewardedPlayerEnabled(context)) {
            LevelPlayInterstitialAdProvider(context)
        } else {
            UnityInterstitialAdProvider(context)
        }

    /**
     * Com o LevelPlay liberado, ele inicializa a Unity (via adaptador) primeiro e o SDK direto so a reaproveita:
     * espera limitada (5 s), sem travar o anuncio se o LevelPlay falhar.
     */
    suspend fun aguardarMediacao(context: Context) {
        if (!ObaflixAdEligibility.allowsAds || !ObaflixAdsConfig.levelPlayAllowed(context)) return
        // With the S2S Rewarded on, LevelPlay must start with the account's backend-issued USER_ID; a bare start here
        // would win the race and keep it out. The identity-aware warm-up starts it (and is a no-op if already running).
        if (ObaflixAdsConfig.rewardedPlayerEnabled(context)) ObaflixRewardedPlayback.aquecer(context) else ObaflixLevelPlay.start(context)
        kotlinx.coroutines.withTimeoutOrNull(MEDIACAO_ESPERA_MS) { ObaflixLevelPlay.ready.first { it } }
    }

    private const val MEDIACAO_ESPERA_MS = 5_000L

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
        if (!ObaflixAdEligibility.allowsAds) return
        val p = provider(context)
        p.initialize()
        p.preload()
    }

    /** Ponto de injecao para teste. Producao nunca chama. */
    fun substituirProvedorParaTeste(novo: InterstitialAdProvider?) {
        synchronized(this) { provedor = novo }
    }
}
