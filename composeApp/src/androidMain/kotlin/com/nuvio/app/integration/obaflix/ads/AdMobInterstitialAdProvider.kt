package com.nuvio.app.integration.obaflix.ads

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.google.android.gms.ads.AdError
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.FullScreenContentCallback
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.interstitial.InterstitialAd
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Interstitial over AdMob, same [InterstitialAdProvider] contract as the Unity one (one terminal callback, 8 s watchdog
 * until the ad is on screen). It never initializes the SDK: [ObaflixAdMob.aguardar] (consent + init) must have succeeded,
 * otherwise [preload] does nothing. AdMob reports no completion, so a dismissed ad is [AdShowOutcome.SKIPPED]: it never
 * claims "watched" and /api/ads/complete keeps the server-side minimum time.
 */
internal class AdMobInterstitialAdProvider(
    context: Context,
    private val unitId: String = ObaflixAdMob.interstitialUnit(context),
    private val liberado: () -> Boolean = { ObaflixAdMob.interstitialSelecionado(context) },
) : InterstitialAdProvider {

    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private var ad: InterstitialAd? = null
    private var carregadoEm = 0L

    @Volatile private var carregando = false

    override val pronto: Boolean
        get() = liberado() && ad != null && System.currentTimeMillis() - carregadoEm < VALIDADE_MS

    override fun initialize() = Unit // consent + SDK init are ObaflixAdMob.aguardar's job, never implicit

    override fun preload() {
        if (!liberado() || carregando || pronto) return
        carregando = true
        InterstitialAd.load(app, unitId, AdRequest.Builder().build(), object : InterstitialAdLoadCallback() {
            override fun onAdLoaded(loaded: InterstitialAd) {
                carregando = false
                ad = loaded
                carregadoEm = System.currentTimeMillis()
                ObaLog.evento(FASE, "admob_interstitial_load_ok")
            }

            override fun onAdFailedToLoad(error: LoadAdError) {
                carregando = false // no retry loop; the next intention preloads again
                ObaLog.alerta(FASE, "admob_interstitial_load_error", "code" to error.code)
            }
        })
    }

    override fun show(host: AdHost, aoAbrir: () -> Unit, aoTerminar: (AdShowOutcome) -> Unit) {
        val gasta = AtomicBoolean(false)
        var watchdog: Runnable? = null

        fun terminar(resultado: AdShowOutcome, motivo: String) {
            if (!gasta.compareAndSet(false, true)) return
            watchdog?.let { main.removeCallbacks(it) }
            ObaLog.evento(FASE, "admob_interstitial_show_end", "motivo" to motivo)
            aoTerminar(resultado)
        }

        val activity = (host as? ActivityAdHost)?.activity()
        val anuncio = ad.takeIf { pronto }
        if (activity == null || anuncio == null) {
            terminar(AdShowOutcome.NAO_EXIBIDO, "indisponivel")
            return
        }
        ad = null // an AdMob interstitial is single-use
        val cao = Runnable { terminar(AdShowOutcome.NAO_EXIBIDO, "timeout") }
        watchdog = cao
        main.postDelayed(cao, TIMEOUT_EXIBICAO_MS)
        anuncio.fullScreenContentCallback = object : FullScreenContentCallback() {
            override fun onAdShowedFullScreenContent() {
                main.removeCallbacks(cao)
                aoAbrir()
            }

            override fun onAdFailedToShowFullScreenContent(error: AdError) {
                ObaLog.alerta(FASE, "admob_interstitial_show_error", "code" to error.code)
                terminar(AdShowOutcome.NAO_EXIBIDO, "falha_exibicao")
            }

            override fun onAdDismissedFullScreenContent() = terminar(AdShowOutcome.SKIPPED, "fechado")
        }
        runCatching { anuncio.show(activity) }.onFailure {
            ObaLog.alerta(FASE, "admob_interstitial_show_error", "excecao" to it.javaClass.simpleName)
            terminar(AdShowOutcome.NAO_EXIBIDO, "excecao")
        }
    }

    private companion object {
        const val FASE = "ADS"
        const val TIMEOUT_EXIBICAO_MS = 8_000L
        const val VALIDADE_MS = 50 * 60 * 1000L // AdMob drops loaded interstitials after 1 h
    }
}
