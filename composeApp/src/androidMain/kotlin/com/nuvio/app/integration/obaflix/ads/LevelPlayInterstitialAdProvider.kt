package com.nuvio.app.integration.obaflix.ads

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.nuvio.app.integration.obaflix.ObaflixAdEligibility
import com.unity3d.mediation.LevelPlayAdError
import com.unity3d.mediation.LevelPlayAdInfo
import com.unity3d.mediation.interstitial.LevelPlayInterstitialAd
import com.unity3d.mediation.interstitial.LevelPlayInterstitialAdListener
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Interstitial over LevelPlay, same [InterstitialAdProvider] contract as [UnityInterstitialAdProvider]
 * (one terminal callback, 8 s watchdog until the ad is on screen). Not selected yet: see
 * [ObaflixAdsConfig.INTERSTITIAL_VIA_LEVELPLAY]. LevelPlay reports no completion state, so a closed ad is
 * [AdShowOutcome.SKIPPED]: it never claims "watched", and /api/ads/complete keeps the server-side minimum time.
 */
internal class LevelPlayInterstitialAdProvider(
    context: Context,
    private val unitId: String = ObaflixAdsConfig.LEVELPLAY_INTERSTITIAL_UNIT_ID,
    private val elegivel: () -> Boolean = {
        ObaflixAdEligibility.allowsAds && ObaflixAdsConfig.levelPlayAllowed(context)
    },
    private val sdkPronto: () -> Boolean = { ObaflixLevelPlay.ready.value },
) : InterstitialAdProvider {

    private val app = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private var ad: LevelPlayInterstitialAd? = null

    @Volatile private var carregando = false
    @Volatile private var atual: Exibicao? = null

    private class Exibicao(val aoAbrir: () -> Unit, val terminar: (AdShowOutcome, String) -> Unit)

    override val pronto: Boolean
        get() = elegivel() && sdkPronto() && ad?.isAdReady() == true

    override fun initialize() {
        if (!elegivel()) return
        ObaflixLevelPlay.start(app)
    }

    override fun preload() {
        if (!elegivel() || !sdkPronto() || carregando || pronto || unitId.isBlank()) return
        val unidade = ad ?: LevelPlayInterstitialAd(unitId).also { novo ->
            novo.setListener(listener)
            ad = novo
        }
        carregando = true
        runCatching { unidade.loadAd() }.onFailure {
            carregando = false
            ObaLog.alerta(FASE, "levelplay_load_error", "excecao" to it.javaClass.simpleName)
        }
    }

    override fun show(host: AdHost, aoAbrir: () -> Unit, aoTerminar: (AdShowOutcome) -> Unit) {
        val gasta = AtomicBoolean(false)
        var watchdog: Runnable? = null

        fun terminar(resultado: AdShowOutcome, motivo: String) {
            if (!gasta.compareAndSet(false, true)) return
            watchdog?.let { main.removeCallbacks(it) }
            atual = null
            ObaLog.evento(FASE, "levelplay_show_end", "motivo" to motivo)
            aoTerminar(resultado)
        }

        val activity = (host as? ActivityAdHost)?.activity()
        val anuncio = ad
        if (activity == null || anuncio == null || !pronto) {
            terminar(AdShowOutcome.NAO_EXIBIDO, "indisponivel")
            return
        }
        val cao = Runnable { terminar(AdShowOutcome.NAO_EXIBIDO, "timeout") }
        watchdog = cao
        main.postDelayed(cao, TIMEOUT_EXIBICAO_MS)

        atual = Exibicao(
            aoAbrir = {
                main.removeCallbacks(cao)
                aoAbrir()
            },
            terminar = ::terminar,
        )
        runCatching { anuncio.showAd(activity) }.onFailure {
            ObaLog.alerta(FASE, "levelplay_show_error", "excecao" to it.javaClass.simpleName)
            terminar(AdShowOutcome.NAO_EXIBIDO, "excecao")
        }
    }

    private val listener = object : LevelPlayInterstitialAdListener {
        override fun onAdLoaded(adInfo: LevelPlayAdInfo) {
            carregando = false
            ObaLog.evento(FASE, "levelplay_load_ok")
        }

        override fun onAdLoadFailed(error: LevelPlayAdError) {
            carregando = false // no retry loop; the next intention preloads again
            ObaLog.alerta(FASE, "levelplay_load_error", "erro" to error.errorMessage)
        }

        override fun onAdDisplayed(adInfo: LevelPlayAdInfo) {
            atual?.aoAbrir?.invoke()
        }

        override fun onAdDisplayFailed(error: LevelPlayAdError, adInfo: LevelPlayAdInfo) {
            ObaLog.alerta(FASE, "levelplay_show_error", "erro" to error.errorMessage)
            atual?.terminar?.invoke(AdShowOutcome.NAO_EXIBIDO, "falha_exibicao")
        }

        override fun onAdClosed(adInfo: LevelPlayAdInfo) {
            atual?.terminar?.invoke(AdShowOutcome.SKIPPED, "fechado")
        }
    }

    private companion object {
        const val FASE = "ADS"
        const val TIMEOUT_EXIBICAO_MS = 8_000L
    }
}
