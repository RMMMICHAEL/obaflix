package com.nuvio.app.integration.obaflix.ads

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.google.android.gms.ads.AdError
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.FullScreenContentCallback
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.OnUserEarnedRewardListener
import com.google.android.gms.ads.rewarded.RewardedAd
import com.google.android.gms.ads.rewarded.RewardedAdLoadCallback
import com.google.android.gms.ads.rewarded.ServerSideVerificationOptions

/**
 * Rewarded over AdMob. Like the LevelPlay one it grants nothing: it only reports a [RewardedResult]. The proof the
 * playback gate needs is the server's own AdMob server-side-verification receipt (`/api/ads/admob/ssv`), tied to this
 * attempt through the SSV `user_id` (the account's Rewarded identity) and `custom_data` (the one-shot challenge nonce).
 * It never initializes the SDK ([ObaflixAdMob.aguardar] does) and never loads while not [liberado].
 */
internal class AdMobRewardedAdProvider(
    context: Context,
    private val unitId: String = ObaflixAdMob.rewardedUnit(context),
    private val liberado: () -> Boolean = { ObaflixAdMob.rewardedSelecionado(context) },
    private val log: (String) -> Unit = {},
) {
    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private var ad: RewardedAd? = null
    private var carregadoEm = 0L
    private var ultimaFalhaEm = 0L

    @Volatile private var carregando = false
    @Volatile private var exibindo = false

    val pronto: Boolean
        get() = liberado() && ad != null && System.currentTimeMillis() - carregadoEm < VALIDADE_MS

    /** Asks for an ad unless one is loaded or loading, or the last attempt failed moments ago. Never shows anything. */
    fun carregar() {
        if (!liberado() || carregando || exibindo || pronto) return
        if (System.currentTimeMillis() - ultimaFalhaEm < PAUSA_APOS_FALHA_MS) return
        carregando = true
        log("load_start")
        RewardedAd.load(app, unitId, AdRequest.Builder().build(), object : RewardedAdLoadCallback() {
            override fun onAdLoaded(loaded: RewardedAd) {
                carregando = false
                ad = loaded
                carregadoEm = System.currentTimeMillis()
                log("load_ok")
            }

            override fun onAdFailedToLoad(error: LoadAdError) {
                carregando = false
                ultimaFalhaEm = System.currentTimeMillis()
                log("load_falha code=${error.code}")
            }
        })
    }

    fun exibir(activity: Activity, userId: String, customData: String, aoTerminar: (RewardedResult) -> Unit) {
        val anuncio = ad.takeIf { pronto }
        if (anuncio == null || exibindo) {
            aoTerminar(RewardedResult.INDISPONIVEL)
            return
        }
        ad = null // single-use
        exibindo = true
        var watchdog: Runnable? = null
        val tracker = RewardedShowTracker(
            finish = { resultado ->
                watchdog?.let { main.removeCallbacks(it) }
                exibindo = false
                log("show_fim resultado=$resultado")
                aoTerminar(resultado)
            },
            log = log,
            agendar = { atrasoMs, acao ->
                val tarefa = Runnable { acao() }
                main.postDelayed(tarefa, atrasoMs)
                ({ main.removeCallbacks(tarefa) })
            },
        )
        val cao = Runnable { tracker.onTimeout() }
        watchdog = cao
        main.postDelayed(cao, TIMEOUT_EXIBICAO_MS)
        // Must be set right before show: both values are bound to this challenge on the server.
        anuncio.setServerSideVerificationOptions(
            ServerSideVerificationOptions.Builder().setUserId(userId).setCustomData(customData).build(),
        )
        anuncio.fullScreenContentCallback = object : FullScreenContentCallback() {
            override fun onAdShowedFullScreenContent() {
                main.removeCallbacks(cao)
                log("exibido")
            }

            override fun onAdFailedToShowFullScreenContent(error: AdError) {
                log("falha_exibicao code=${error.code}")
                tracker.onDisplayFailed()
            }

            override fun onAdDismissedFullScreenContent() {
                log("fechado")
                tracker.onClosed()
            }
        }
        runCatching { anuncio.show(activity, OnUserEarnedRewardListener { tracker.onRewarded() }) }.onFailure {
            log("show_excecao ${it.javaClass.simpleName}")
            tracker.onDisplayFailed()
        }
    }

    private companion object {
        const val TIMEOUT_EXIBICAO_MS = 8_000L
        const val PAUSA_APOS_FALHA_MS = 5_000L
        const val VALIDADE_MS = 50 * 60 * 1000L
    }
}
