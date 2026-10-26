package com.nuvio.app.integration.obaflix.ads

import android.app.Activity
import android.content.Context
import com.unity3d.mediation.LevelPlay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * DEBUG-only door to the Rewarded test: every entry is a no-op unless the build is debuggable. It does not use
 * the commercial eligibility and does not touch banners, Interstitial, the playback gate or the server, and a
 * reward here unlocks nothing.
 */
object ObaflixRewardedHomologacao {
    private val _linhas = MutableStateFlow<List<String>>(emptyList())
    val linhas: StateFlow<List<String>> get() = _linhas

    @Volatile private var provedor: LevelPlayRewardedAdProvider? = null

    fun disponivel(context: Context): Boolean = ObaflixAdsConfig.isTestMode(context)

    fun sdkPronto(): Boolean = ObaflixLevelPlay.ready.value

    fun rewardedPronto(): Boolean = provedor?.pronto == true

    fun iniciar(context: Context) {
        if (!disponivel(context)) return
        registrar("init_start appKey=${ObaflixAdsConfig.LEVELPLAY_APP_KEY} sdk=${runCatching { LevelPlay.getSdkVersion() }.getOrNull()}")
        ObaflixLevelPlay.startHomologacaoDebug(context)
        provedor(context).ativar() // auto preload once LevelPlay is ready; never auto-shows
    }

    fun carregar(context: Context) {
        if (!disponivel(context)) return
        provedor(context).carregar()
    }

    fun exibir(activity: Activity) {
        if (!disponivel(activity)) return
        provedor(activity).exibir(activity) { registrar("RESULTADO $it (nada foi liberado)") }
    }

    /** LevelPlay test suite: loads network test ads from the dashboard. Debug only. */
    fun abrirTestSuite(context: Context) {
        if (!disponivel(context)) return
        runCatching { LevelPlay.launchTestSuite(context) }.onFailure { registrar("test_suite_erro ${it.javaClass.simpleName}") }
    }

    private fun provedor(context: Context): LevelPlayRewardedAdProvider =
        provedor ?: synchronized(this) {
            provedor ?: LevelPlayRewardedAdProvider(
                permitido = { disponivel(context.applicationContext) },
                log = ::registrar,
            ).also { provedor = it }
        }

    private fun registrar(linha: String) {
        ObaLog.evento("ADS", "rewarded_hml", "msg" to linha)
        _linhas.value = (_linhas.value + linha).takeLast(60)
    }
}
