package com.obaflix.ads

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.obaflix.BuildConfig
import com.obaflix.bridge.ObaLog
import com.unity3d.ads.IUnityAdsInitializationListener
import com.unity3d.ads.IUnityAdsLoadListener
import com.unity3d.ads.IUnityAdsShowListener
import com.unity3d.ads.UnityAds
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Implementacao do [InterstitialAdProvider] sobre o SDK da Unity Ads.
 *
 * Unico arquivo do aplicativo que importa `com.unity3d.*`. Toda a decisao de
 * quando exibir vive em [PlaybackAdGate] e [SeriesAdFrequencyPolicy], que nao
 * conhecem o SDK e por isso rodam em teste JVM puro.
 *
 * Guarda apenas o `applicationContext` — nenhuma referencia a Activity fora da
 * chamada de [show], que a recebe de um [ActivityAdHost] (referencia fraca).
 *
 * Nao usa corrotinas: as callbacks do SDK ja chegam pela thread principal e o
 * unico agendamento e o watchdog, num [Handler] do looper principal, cancelado
 * assim que a callback real chega. Nada de `GlobalScope`.
 */
class UnityInterstitialAdProvider(
    context: Context,
    private val gameId: String = BuildConfig.UNITY_ADS_GAME_ID,
    private val placementId: String = BuildConfig.UNITY_ADS_PLACEMENT_ID,
    private val testMode: Boolean = BuildConfig.UNITY_ADS_TEST_MODE,
) : InterstitialAdProvider {

    private val app: Context = context.applicationContext
    private val main = Handler(Looper.getMainLooper())

    @Volatile private var inicializando = false
    @Volatile private var inicializado = false
    @Volatile private var carregando = false
    @Volatile private var carregado = false

    override val pronto: Boolean
        get() = inicializado && carregado

    override fun initialize() {
        if (inicializado || inicializando) return
        inicializando = true
        ObaLog.evento(
            PlaybackAdGate.FASE, "unity_init_start",
            "teste" to testMode,
            "sdk" to runCatching { UnityAds.version }.getOrNull(),
        )
        runCatching {
            UnityAds.initialize(app, gameId, testMode, object : IUnityAdsInitializationListener {
                override fun onInitializationComplete() {
                    inicializando = false
                    inicializado = true
                    ObaLog.evento(PlaybackAdGate.FASE, "unity_init_ok")
                    // Primeiro interstitial ja a caminho: quando o usuario tocar
                    // em ASSISTIR, o anuncio precisa ja estar carregado.
                    preload()
                }

                override fun onInitializationFailed(
                    erro: UnityAds.UnityAdsInitializationError?,
                    mensagem: String?,
                ) {
                    inicializando = false
                    inicializado = false
                    // Sem retentativa e sem tela de erro: com o SDK fora do ar,
                    // [pronto] fica false e o gate segue direto a reproducao.
                    ObaLog.alerta(
                        PlaybackAdGate.FASE, "unity_init_error",
                        "erro" to (erro?.name ?: "desconhecido"),
                    )
                }
            })
        }.onFailure { e ->
            inicializando = false
            ObaLog.alerta(
                PlaybackAdGate.FASE, "unity_init_error",
                "excecao" to e.javaClass.simpleName,
            )
        }
    }

    override fun preload() {
        if (!inicializado || carregado || carregando) return
        carregando = true
        ObaLog.evento(PlaybackAdGate.FASE, "unity_load_start")
        runCatching {
            UnityAds.load(placementId, object : IUnityAdsLoadListener {
                override fun onUnityAdsAdLoaded(placement: String?) {
                    carregando = false
                    carregado = true
                    ObaLog.evento(PlaybackAdGate.FASE, "unity_load_ok")
                }

                override fun onUnityAdsFailedToLoad(
                    placement: String?,
                    erro: UnityAds.UnityAdsLoadError?,
                    mensagem: String?,
                ) {
                    carregando = false
                    carregado = false
                    // Sem inventario ou falha de rede: nao insiste aqui. O
                    // proximo preload sai no fim da proxima intencao de
                    // reproducao, nunca num laco de retentativa.
                    ObaLog.alerta(
                        PlaybackAdGate.FASE, "unity_load_error",
                        "erro" to (erro?.name ?: "desconhecido"),
                    )
                }
            })
        }.onFailure { e ->
            carregando = false
            ObaLog.alerta(
                PlaybackAdGate.FASE, "unity_load_error",
                "excecao" to e.javaClass.simpleName,
            )
        }
    }

    override fun show(host: AdHost, aoAbrir: () -> Unit, aoTerminar: (AdShowOutcome) -> Unit) {
        // Contrato da interface: aoTerminar roda exatamente uma vez. Watchdog e
        // callback do SDK competem de proposito; quem chegar primeiro vence.
        val gasta = AtomicBoolean(false)
        val abriu = AtomicBoolean(false)
        var watchdog: Runnable? = null

        fun terminar(resultado: AdShowOutcome, motivo: String) {
            if (!gasta.compareAndSet(false, true)) return
            watchdog?.let { main.removeCallbacks(it) }
            if (resultado == AdShowOutcome.EXIBIDO || motivo == "falha_exibicao") {
                // O SDK consumiu o interstitial carregado; o proximo precisa ser
                // pedido de novo.
                carregado = false
            }
            ObaLog.evento(PlaybackAdGate.FASE, "unity_show_end", "motivo" to motivo)
            aoTerminar(resultado)
        }

        val activity = (host as? ActivityAdHost)?.activity()
        if (activity == null || !pronto) {
            terminar(AdShowOutcome.NAO_EXIBIDO, "indisponivel")
            return
        }

        // Rede lenta ou SDK em silencio nao podem prender a reproducao: sem
        // nenhuma callback, o watchdog libera assim mesmo.
        val cao = Runnable { terminar(AdShowOutcome.NAO_EXIBIDO, "timeout") }
        watchdog = cao
        main.postDelayed(cao, TIMEOUT_EXIBICAO_MS)

        ObaLog.evento(PlaybackAdGate.FASE, "unity_show_start")
        runCatching {
            UnityAds.show(activity, placementId, object : IUnityAdsShowListener {
                override fun onUnityAdsShowStart(placement: String?) {
                    ObaLog.evento(PlaybackAdGate.FASE, "unity_show_shown")
                    // O anuncio esta na tela: quem decide quando fechar passa a
                    // ser o usuario, e o watchdog sai de cena. A partir daqui ha
                    // uma Activity do SDK sobreposta — o gate so pode liberar
                    // quando a NOSSA Activity recuperar o foco, nunca so pelo
                    // callback terminal (que chega com o end-card ainda na tela).
                    main.removeCallbacks(cao)
                    if (abriu.compareAndSet(false, true)) aoAbrir()
                }

                override fun onUnityAdsShowClick(placement: String?) = Unit

                override fun onUnityAdsShowComplete(
                    placement: String?,
                    estado: UnityAds.UnityAdsShowCompletionState?,
                ) {
                    // COMPLETED (assistiu ate o fim) e SKIPPED (fechou no X) sao
                    // o mesmo caso aqui: o anuncio apareceu e ja foi fechado.
                    ObaLog.evento(PlaybackAdGate.FASE, "unity_show_complete")
                    terminar(AdShowOutcome.EXIBIDO, "fechado")
                }

                override fun onUnityAdsShowFailure(
                    placement: String?,
                    erro: UnityAds.UnityAdsShowError?,
                    mensagem: String?,
                ) {
                    ObaLog.alerta(
                        PlaybackAdGate.FASE, "unity_show_error",
                        "erro" to (erro?.name ?: "desconhecido"),
                    )
                    terminar(AdShowOutcome.NAO_EXIBIDO, "falha_exibicao")
                }
            })
        }.onFailure { e ->
            ObaLog.alerta(
                PlaybackAdGate.FASE, "unity_show_error",
                "excecao" to e.javaClass.simpleName,
            )
            terminar(AdShowOutcome.NAO_EXIBIDO, "excecao")
        }
    }

    private companion object {
        /**
         * Espera maxima ate o anuncio aparecer. Depois de `onUnityAdsShowStart`
         * o watchdog e cancelado — dali em diante nao ha limite de tempo, porque
         * quem fecha e o usuario.
         */
        const val TIMEOUT_EXIBICAO_MS = 8_000L
    }
}
