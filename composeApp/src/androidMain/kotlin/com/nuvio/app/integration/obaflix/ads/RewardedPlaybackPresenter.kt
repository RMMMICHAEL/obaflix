package com.nuvio.app.integration.obaflix.ads

import android.app.AlertDialog
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.nuvio.app.integration.obaflix.AdChoice
import com.nuvio.app.integration.obaflix.ObaflixAdEligibility
import com.nuvio.app.integration.obaflix.ObaflixAdProviderChoice
import com.nuvio.app.integration.obaflix.ObaflixRewardedApi
import com.nuvio.app.integration.obaflix.ObaflixRewardedPresenter
import com.nuvio.app.integration.obaflix.ObaflixSession
import com.nuvio.app.integration.obaflix.RewardStatus
import com.nuvio.app.integration.obaflix.RewardedAttempt
import com.unity3d.mediation.LevelPlay
import java.lang.ref.WeakReference
import com.nuvio.app.integration.obaflix.ObaflixAdChoice
import com.nuvio.app.integration.obaflix.RewardedCancellation
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/**
 * Activity-bound door of the S2S Rewarded for the playback gate: the explicit choice, then the Rewarded flow.
 * Registered next to [UnityAdPresenter]. Both presenters are independent alternatives for one challenge, never both.
 */
internal class RewardedPlaybackPresenter(activity: ComponentActivity) : ObaflixRewardedPresenter {
    private val ref = WeakReference(activity)

    private fun viva(): ComponentActivity? = ref.get()?.takeIf { !it.isFinishing && !it.isDestroyed }

    override fun disponivel(): Boolean = viva()?.let {
        if (ObaflixAdMob.rewardedSelecionado(it)) ObaflixAdMobRewarded.oferecido(it) else ObaflixRewardedPlayback.oferecido(it)
    } == true

    override fun aquecer() {
        val activity = viva() ?: return
        activity.lifecycleScope.launch {
            // The server's pick comes first: with AdMob chosen LevelPlay is not started for the Rewarded (AdMob loads on demand).
            ObaflixAdProviderChoice.refresh()
            if (ObaflixAdMob.rewardedSelecionado(activity)) return@launch
            if (ObaflixRewardedPlayback.habilitado(activity)) ObaflixRewardedPlayback.aquecer(activity.applicationContext)
        }
    }

    override suspend fun escolher(): AdChoice {
        viva() ?: return AdChoice.CANCELADO
        // "Assistir anúncio e continuar" is a layer over the loading screen (ObaflixAdChoiceHost), not a dialog.
        return if (ObaflixAdChoice.ask()) AdChoice.REWARDED else AdChoice.CANCELADO
    }

    override suspend fun consultar(desafioId: String): RewardStatus =
        ObaflixRewardedApi.estado(desafioId) ?: RewardStatus.PENDENTE // an error never drops or grants

    override suspend fun mostrar(desafioId: String): RewardedAttempt = withContext(Dispatchers.Main) {
        val activity = viva() ?: return@withContext RewardedAttempt.NAO_EXIBIDO
        val conta = ObaflixSession.user?.userId ?: return@withContext RewardedAttempt.NAO_EXIBIDO
        ObaflixAdProviderChoice.refresh()
        val admob = ObaflixAdMob.rewardedSelecionado(activity)
        val oferecido = if (admob) ObaflixAdMobRewarded.oferecido(activity) else ObaflixRewardedPlayback.oferecido(activity)
        if (!ObaflixAdEligibility.allowsAds || !oferecido) return@withContext RewardedAttempt.NAO_EXIBIDO

        val cancelado = RewardedCancellation()
        val seguir = { !cancelado.isCancelled }
        val mesmaConta = { ObaflixSession.user?.userId == conta }
        val aviso = AlertDialog.Builder(activity)
            .setMessage("Preparando o anúncio…")
            // No Cancel button, but Back leaves: before the ad nothing was granted or is kept (the slot is released), after it
            // the server's confirmation stays PENDENTE and is never assumed. Both waits are bounded anyway.
            .setOnCancelListener { cancelado.userCancelled() }
            .create()
        // The Activity is routinely recreated right after the ad (it did on the S9+): that is not the user giving up. Only
        // before the ad shows does losing the Activity cancel; afterwards the wait for the server confirmation goes on.
        activity.dispensarAoDestruir(aviso) { cancelado.activityDestroyed() }
        aviso.show()
        val provedor = ObaflixRewardedPlayback.provedor
        try {
            RewardedPlaybackFlow(
                aguardarPronto = {
                    if (admob) ObaflixAdMobRewarded.aguardarPronto(activity, continuar = { seguir() && mesmaConta() })
                    else ObaflixRewardedPlayback.aguardarPronto(activity, continuar = { seguir() && mesmaConta() })
                },
                seguir = seguir,
                mesmaConta = mesmaConta,
                canceladoPeloUsuario = { cancelado.cancelledByUser },
                preparar = ObaflixRewardedApi::preparar,
                // Must be set right before showAd: the identifier is bound to this challenge on the server.
                definirId = { if (admob) ObaflixAdMobRewarded.definirId(it) else LevelPlay.setDynamicUserId(it) },
                exibir = {
                    cancelado.adShown()
                    aviso.dismiss() // the ad is about to take the screen
                    val resultado = suspendCancellableCoroutine { cont ->
                        val aoTerminar = { r: RewardedResult -> if (cont.isActive) cont.resume(r) }
                        if (admob) ObaflixAdMobRewarded.exibir(activity, aoTerminar) else provedor.exibir(activity, aoTerminar)
                    }
                    // Back from the ad: the server confirmation (up to a bounded wait) happens behind this message.
                    // The Activity may have been recreated while the ad was on screen: never show a window on a dead one.
                    if (!activity.isFinishing && !activity.isDestroyed) {
                        // Confirmation and normal preparation: progress only, no Cancel and no back-to-cancel.
                        aviso.setMessage("Preparando reprodução…")
                        if (!aviso.isShowing) aviso.show()
                    }
                    resultado
                },
                confirmada = ObaflixRewardedApi::confirmada,
                tentativas = 8, // ~12 s of confirmation; a slower signed callback is resumed from PENDENTE on the next request
                cancelar = { ObaflixRewardedApi.cancelar(it) },
                log = { ObaLog.evento("ADS", "rewarded_player", "msg" to it) },
            ).executar(desafioId)
        } finally {
            runCatching { aviso.dismiss() }
        }
    }
}
