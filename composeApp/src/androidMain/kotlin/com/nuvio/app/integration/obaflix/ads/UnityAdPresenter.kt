package com.nuvio.app.integration.obaflix.ads

import androidx.activity.ComponentActivity
import androidx.lifecycle.withResumed
import com.nuvio.app.integration.obaflix.ObaflixAdEligibility
import com.nuvio.app.integration.obaflix.ObaflixAdPresenter
import java.lang.ref.WeakReference
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Compose host for the official interstitial: shows the Unity ad over [activity] when the server
 * asked for one. It only reports what happened; the server decides (via `/api/ads/complete`).
 */
internal class UnityAdPresenter(activity: ComponentActivity) : ObaflixAdPresenter {
    private val ref = WeakReference(activity)

    override suspend fun show(): Boolean = withContext(Dispatchers.Main) {
        val activity = ref.get()?.takeIf { !it.isFinishing && !it.isDestroyed } ?: return@withContext false
        if (!ObaflixAdEligibility.allowsAds) return@withContext false
        ObaflixAds.aguardarMediacao(activity)
        val provider = ObaflixAds.provider(activity)
        provider.initialize()
        provider.preload()
        // The SDK loads asynchronously; the official provider has no "ready" callback, so poll briefly.
        withTimeoutOrNull(LOAD_WAIT_MS) { while (!provider.pronto) delay(250) }
        if (!provider.pronto) return@withContext false

        var opened = false
        val outcome = suspendCancellableCoroutine { cont ->
            provider.show(ActivityAdHost(activity), aoAbrir = { opened = true }) { result ->
                if (cont.isActive) cont.resume(result)
            }
        }
        // Official rule: once the ad opened, only our Activity regaining the foreground proves it was dismissed.
        if (opened) activity.lifecycle.withResumed { }
        provider.preload()
        outcome != AdShowOutcome.NAO_EXIBIDO
    }

    override suspend fun confirmar(finalidade: String, alternativaDoRewarded: Boolean): Boolean {
        val activity = ref.get()?.takeIf { !it.isFinishing && !it.isDestroyed } ?: return false
        val alvo = textoDoAnuncio(finalidade)
        return if (alternativaDoRewarded) {
            activity.confirmarAnuncio(
                "Anúncio com recompensa indisponível",
                "Você pode assistir a um anúncio comum para liberar $alvo.",
                "Assistir anúncio comum",
            )
        } else {
            activity.confirmarAnuncio(
                "Liberar $alvo",
                "Assista a um anúncio para liberar $alvo.",
                "Assistir anúncio para liberar $alvo",
            )
        }
    }

    private companion object {
        const val LOAD_WAIT_MS = 10_000L
    }
}
