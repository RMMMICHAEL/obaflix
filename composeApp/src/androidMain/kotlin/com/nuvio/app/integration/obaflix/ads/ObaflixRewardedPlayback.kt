package com.nuvio.app.integration.obaflix.ads

import android.content.Context
import com.nuvio.app.integration.obaflix.ObaflixAdEligibility
import com.nuvio.app.integration.obaflix.ObaflixRewardedApi
import com.nuvio.app.integration.obaflix.ObaflixSession
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.delay

/**
 * State of the S2S Rewarded for playback. Off unless [ObaflixAdsConfig.REWARDED_PLAYER_ENABLED]; commercial
 * eligibility (a server `ANUNCIO_NECESSARIO`) is also required, so exempt subscribers never reach it.
 *
 * LevelPlay initializes once per process, with the backend-issued USER_ID of the account that was signed in at
 * that moment. After a sign-out/sign-in as someone else the ids differ, [oferecido] turns false and the Rewarded
 * waits for the next launch (the Interstitial keeps working): a callback signed for the old account can never pay
 * the new one, and the server also resolves the event to the old account.
 */
internal object ObaflixRewardedPlayback {
    @Volatile private var liberado = false
    @Volatile private var identidade: Pair<String, String>? = null // account id to LevelPlay USER_ID
    private val aquecendo = AtomicBoolean(false)

    val provedor: LevelPlayRewardedAdProvider by lazy {
        LevelPlayRewardedAdProvider(
            permitido = { liberado && ObaflixAdEligibility.allowsAds },
            log = { ObaLog.evento("ADS", "rewarded_player", "msg" to it) },
        )
    }

    fun habilitado(context: Context): Boolean =
        ObaflixAdsConfig.rewardedPlayerEnabled(context) && ObaflixAdsConfig.levelPlayAllowed(context)

    /** Identity → init with it → auto preload. Idempotent; a failure just leaves the Rewarded unavailable. */
    suspend fun aquecer(context: Context) {
        if (!habilitado(context) || !ObaflixAdEligibility.allowsAds) return
        if (!aquecendo.compareAndSet(false, true)) return
        try {
            val usuario = ObaflixSession.user ?: return
            if (identidade?.first != usuario.userId) {
                val uid = ObaflixRewardedApi.identidade() ?: return
                identidade = usuario.userId to uid
            }
            liberado = true
            ObaflixLevelPlay.startComIdentidade(context, identidade!!.second)
            provedor.ativar()
        } finally {
            aquecendo.set(false)
        }
    }

    /**
     * Can the Rewarded be offered to this account right now? Not "is it loaded": a load in progress is awaited by the
     * flow. False when LevelPlay was already started without this account's identity (another account earlier, or
     * something else started it), so the choice is never offered for something that cannot work.
     */
    fun oferecido(context: Context): Boolean {
        if (!habilitado(context) || !ObaflixAdEligibility.allowsAds) return false
        val userId = ObaflixSession.user?.userId ?: return false
        if (!ObaflixLevelPlay.initRequested) return true // it will start with this account's identity
        val id = identidade ?: return false
        return id.first == userId && ObaflixLevelPlay.requestedUserId == id.second
    }

    /** Identity matches the running LevelPlay and the ad is loaded. */
    fun pronto(): Boolean {
        val id = identidade ?: return false
        return liberado &&
            ObaflixAdEligibility.allowsAds &&
            id.first == ObaflixSession.user?.userId &&
            ObaflixLevelPlay.initUserId == id.second &&
            provedor.pronto
    }

    /** Waits (bounded) for init + preload, so the first attempt needs no earlier Interstitial. */
    suspend fun aguardarPronto(context: Context, limiteMs: Long = 20_000L, continuar: () -> Boolean = { true }): Boolean {
        aquecer(context)
        var esperado = 0L
        while (esperado <= limiteMs && continuar()) {
            if (pronto()) return true
            delay(PASSO_MS)
            esperado += PASSO_MS
            if (esperado % 2_000L == 0L) aquecer(context) // identity fetch may have failed once: one more try, bounded
        }
        return pronto()
    }

    private const val PASSO_MS = 250L
}
