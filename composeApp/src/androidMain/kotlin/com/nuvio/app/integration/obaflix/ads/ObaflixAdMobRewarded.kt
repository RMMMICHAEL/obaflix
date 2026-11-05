package com.nuvio.app.integration.obaflix.ads

import android.app.Activity
import android.content.Context
import com.nuvio.app.integration.obaflix.ObaflixAdEligibility
import com.nuvio.app.integration.obaflix.ObaflixRewardedApi
import com.nuvio.app.integration.obaflix.ObaflixSession
import kotlinx.coroutines.delay

/**
 * The AdMob side of the playback Rewarded, next to [ObaflixRewardedPlayback] (LevelPlay). Same release opt-in
 * ([ObaflixAdsConfig.rewardedPlayerEnabled]) and the same server flags apply; this only swaps the ad network, and only
 * when the server picked it ([ObaflixAdMob.rewardedSelecionado]). The account's Rewarded identity is the SSV `user_id`,
 * the challenge nonce from `/api/ads/levelplay/preparar` is the SSV `custom_data`.
 */
internal object ObaflixAdMobRewarded {
    @Volatile private var identidade: Pair<String, String>? = null // account id to Rewarded identity
    @Volatile private var nonce: String? = null
    @Volatile private var provedorCriado: AdMobRewardedAdProvider? = null

    private fun provedor(context: Context): AdMobRewardedAdProvider =
        provedorCriado ?: synchronized(this) {
            provedorCriado ?: AdMobRewardedAdProvider(
                context.applicationContext,
                log = { ObaLog.evento("ADS", "admob_rewarded", "msg" to it) },
            ).also { provedorCriado = it }
        }

    fun oferecido(context: Context): Boolean =
        ObaflixAdsConfig.rewardedPlayerEnabled(context) &&
            ObaflixAdEligibility.allowsAds &&
            ObaflixSession.user != null &&
            ObaflixAdMob.rewardedSelecionado(context)

    /** Consent + SDK init, the account identity, then a bounded wait for a loaded ad. False on any miss: nothing was reserved. */
    suspend fun aguardarPronto(activity: Activity, limiteMs: Long = 20_000L, continuar: () -> Boolean = { true }): Boolean {
        val conta = ObaflixSession.user?.userId ?: return false
        // Stops as soon as the caller does (the user backed out), instead of riding out the consent/init wait.
        val preparo = ObaflixAdMob.iniciar(activity) ?: return false
        var aguardado = 0L
        while (!preparo.isCompleted) {
            if (!continuar() || aguardado >= limiteMs) return false
            delay(PASSO_MS)
            aguardado += PASSO_MS
        }
        if (!preparo.await()) return false
        if (identidade?.first != conta) {
            val uid = ObaflixRewardedApi.identidade() ?: return false
            identidade = conta to uid
        }
        val p = provedor(activity)
        var esperado = 0L
        while (esperado <= limiteMs && continuar()) {
            p.carregar()
            if (p.pronto) return true
            delay(PASSO_MS)
            esperado += PASSO_MS
        }
        return p.pronto
    }

    /** Remembers the challenge nonce for the show that follows; false if the identity is not the signed-in account's. */
    fun definirId(dynamicUserId: String): Boolean {
        if (identidade?.first != ObaflixSession.user?.userId) return false
        nonce = dynamicUserId
        return true
    }

    fun exibir(activity: Activity, aoTerminar: (RewardedResult) -> Unit) {
        val id = identidade
        val n = nonce
        nonce = null // one nonce, one show
        if (id == null || n == null || id.first != ObaflixSession.user?.userId) {
            aoTerminar(RewardedResult.INDISPONIVEL)
            return
        }
        provedor(activity).exibir(activity, userId = id.second, customData = n, aoTerminar = aoTerminar)
    }

    private const val PASSO_MS = 250L
}
