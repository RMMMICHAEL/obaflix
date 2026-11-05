package com.nuvio.app.integration.obaflix.ads

import android.app.Activity
import android.os.Handler
import android.os.Looper
import com.unity3d.mediation.LevelPlayAdError
import com.unity3d.mediation.LevelPlayAdInfo
import com.unity3d.mediation.rewarded.LevelPlayReward
import com.unity3d.mediation.rewarded.LevelPlayRewardedAd
import com.unity3d.mediation.rewarded.LevelPlayRewardedAdListener

/**
 * Rewarded over LevelPlay. Grants nothing: it only reports a [RewardedResult]. Turning RECOMPENSADO into
 * playback/download/cast needs a server-verified proof that does not exist yet, so no caller may do it.
 * [permitido] keeps it off in release (the DEBUG harness is the only caller today).
 */
internal class LevelPlayRewardedAdProvider(
    private val unitId: String = ObaflixAdsConfig.LEVELPLAY_REWARDED_DIRECT_UNIT_ID,
    private val permitido: () -> Boolean,
    private val sdkPronto: () -> Boolean = { ObaflixLevelPlay.ready.value },
    private val log: (String) -> Unit = {},
    private val politica: RewardedReloadPolicy = RewardedReloadPolicy(),
) {
    private val main = Handler(Looper.getMainLooper())
    private var ad: LevelPlayRewardedAd? = null

    @Volatile private var carregando = false
    @Volatile private var atual: Tentativa? = null

    // Auto preload: one pending tick at most, bounded retries, never shows anything by itself.
    private var ativo = false
    private var falhas = 0
    private var espera = 0
    private var agendado: Runnable? = null

    private class Tentativa(val tracker: RewardedShowTracker, val aoAbrir: () -> Unit)

    val pronto: Boolean get() = permitido() && sdkPronto() && ad?.isAdReady() == true

    /** Starts the controlled auto preload (idempotent). Needs [permitido]; waits for LevelPlay, bounded. */
    fun ativar() {
        if (!permitido()) { log("auto_carga_bloqueada: nao e build de homologacao"); return }
        ativo = true
        espera = 0
        agendar(0)
    }

    fun desativar() {
        ativo = false
        agendado?.let { main.removeCallbacks(it) }
        agendado = null
    }

    private fun agendar(atrasoMs: Long) {
        agendado?.let { main.removeCallbacks(it) }
        val tarefa = Runnable { tick() }
        agendado = tarefa
        main.postDelayed(tarefa, atrasoMs)
    }

    private fun tick() {
        agendado = null
        if (!ativo || !permitido()) return
        // Never load while an ad is on screen, and never wait on LevelPlay forever (bounded polling of a flag).
        if (atual != null || !sdkPronto()) {
            if (++espera <= MAX_ESPERA) agendar(ESPERA_MS) else log("auto_carga_parada: LevelPlay/exibicao nao liberou")
            return
        }
        espera = 0
        tentarCarregar()
    }

    /** Manual retry (button): clears the failure count and tries now. */
    fun carregar() {
        falhas = 0
        tentarCarregar()
    }

    private fun tentarCarregar() {
        if (!permitido()) { log("load_bloqueado: nao e build de homologacao"); return }
        if (!sdkPronto()) { log("load_adiado: LevelPlay ainda nao inicializou"); return }
        if (carregando || pronto || unitId.isBlank()) return
        val unidade = ad ?: LevelPlayRewardedAd(unitId).also { novo ->
            novo.setListener(listener)
            ad = novo
        }
        carregando = true
        log("load_start unit=$unitId")
        runCatching { unidade.loadAd() }.onFailure {
            carregando = false
            log("load_excecao ${it.javaClass.simpleName}")
        }
    }

    fun exibir(activity: Activity, aoTerminar: (RewardedResult) -> Unit) {
        if (atual != null) { // a second tap must not end or clear the show in progress
            log("show_ignorado: ja ha uma exibicao em andamento")
            aoTerminar(RewardedResult.INDISPONIVEL)
            return
        }
        var watchdog: Runnable? = null
        val tracker = RewardedShowTracker(
            finish = { resultado ->
                watchdog?.let { main.removeCallbacks(it) }
                atual = null
                log("show_fim resultado=$resultado")
                aoTerminar(resultado)
                // The shown ad is consumed: one controlled reload, only once the screen is free again.
                if (ativo && resultado != RewardedResult.INDISPONIVEL) {
                    falhas = 0
                    agendar(politica.aposExibicaoMs)
                }
            },
            log = log,
            agendar = { atrasoMs, acao ->
                val tarefa = Runnable { acao() }
                main.postDelayed(tarefa, atrasoMs)
                ({ main.removeCallbacks(tarefa) })
            },
        )
        val anuncio = ad
        if (anuncio == null || !pronto || atual != null) {
            tracker.unavailable()
            return
        }
        val cao = Runnable { tracker.onTimeout() }
        watchdog = cao
        main.postDelayed(cao, TIMEOUT_EXIBICAO_MS)
        atual = Tentativa(tracker) { main.removeCallbacks(cao) }
        log("show_start")
        runCatching { anuncio.showAd(activity) }.onFailure {
            log("show_excecao ${it.javaClass.simpleName}")
            tracker.onDisplayFailed()
        }
    }

    private val listener = object : LevelPlayRewardedAdListener {
        override fun onAdLoaded(adInfo: LevelPlayAdInfo) {
            carregando = false
            falhas = 0
            log("load_ok network=${adInfo.adNetwork}")
        }

        override fun onAdLoadFailed(error: LevelPlayAdError) {
            carregando = false
            val tipo = if (error.errorCode in NO_FILL) "no_fill" else "falha_load"
            log("$tipo code=${error.errorCode} msg=${error.errorMessage}")
            falhas++
            val atraso = politica.aposFalha(falhas)
            if (ativo && atraso != null) {
                log("auto_retry em ${atraso}ms (falha $falhas)")
                agendar(atraso)
            } else if (ativo) {
                log("auto_carga_parada apos $falhas falhas; use Carregar para tentar de novo")
            }
        }

        override fun onAdDisplayed(adInfo: LevelPlayAdInfo) {
            log("exibido")
            atual?.aoAbrir?.invoke()
        }

        override fun onAdRewarded(reward: LevelPlayReward, adInfo: LevelPlayAdInfo) {
            val tentativa = atual
            if (tentativa == null) { log("reward_sem_tentativa_ignorado"); return }
            tentativa.tracker.onRewarded()
        }

        override fun onAdDisplayFailed(error: LevelPlayAdError, adInfo: LevelPlayAdInfo) {
            log("falha_exibicao code=${error.errorCode} msg=${error.errorMessage}")
            atual?.tracker?.onDisplayFailed()
        }

        override fun onAdClosed(adInfo: LevelPlayAdInfo) {
            log("fechado")
            atual?.tracker?.onClosed()
        }
    }

    private companion object {
        const val TIMEOUT_EXIBICAO_MS = 8_000L
        const val ESPERA_MS = 500L
        const val MAX_ESPERA = 120 // 60 s

        /** LevelPlay "no ads to show" family, same codes the earlier integration treated as no inventory. */
        val NO_FILL = setOf(509, 606, 1023, 1035)
    }
}
