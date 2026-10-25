package com.nuvio.app.integration.obaflix.ads

import com.nuvio.app.integration.obaflix.ObaflixRewardedApi
import com.nuvio.app.integration.obaflix.RewardedAttempt
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * aguardar carga → preparar → setDynamicUserId → showAd → consultar estado. It never grants anything: the caller
 * (the playback gate) calls `/api/ads/complete` only for [RewardedAttempt.CONFIRMADA], and the server answers 409
 * without its own receipt. The local reward is only the cue to start asking the server.
 *
 * Before `preparar` succeeds nothing is reserved: [RewardedAttempt.NAO_EXIBIDO]. After it the challenge is locked to
 * the Rewarded, so every outcome other than CONFIRMADA is NAO_CONFIRMADA (no Interstitial may follow) and the slot
 * is released with [cancelar] so the account can try again. [seguir] turns false when the user cancels the wait and
 * [mesmaConta] when the account changes.
 *
 * The exception is a Rewarded the user really finished: if the server's signed callback is merely slow (or the user
 * stops waiting), the result is [RewardedAttempt.PENDENTE]. Nothing is released and nothing is cancelled, so a
 * legitimate completion is never thrown away; the gate asks the server again later. A reward is never assumed.
 */
internal class RewardedPlaybackFlow(
    private val aguardarPronto: suspend () -> Boolean,
    private val seguir: () -> Boolean,
    private val mesmaConta: () -> Boolean,
    private val preparar: suspend (String) -> ObaflixRewardedApi.Preparo,
    private val definirId: (String) -> Boolean,
    private val exibir: suspend () -> RewardedResult,
    private val confirmada: suspend (String) -> Boolean?,
    private val cancelar: suspend (String) -> Unit,
    private val esperar: suspend (Long) -> Unit = { delay(it) },
    private val tentativas: Int = 20,
    private val intervaloMs: Long = 1_500L,
    private val tentativasVerificacao: Int = 5,
    private val intervaloVerificacaoMs: Long = 1_500L,
    private val log: (String) -> Unit = {},
) {
    suspend fun executar(desafioId: String): RewardedAttempt {
        // The ad must be loaded before the server reserves anything: a slow load never leaves a pending slot.
        if (!aguardarPronto() || !seguir() || !mesmaConta()) {
            log("rewarded_nao_pronto")
            return RewardedAttempt.NAO_EXIBIDO
        }
        val preparo = preparar(desafioId)
        val dynamicUserId = (preparo as? ObaflixRewardedApi.Preparo.Pronto)?.dynamicUserId
        if (dynamicUserId == null) {
            log("rewarded_nao_preparado: $preparo")
            return RewardedAttempt.NAO_EXIBIDO
        }
        if (!definirId(dynamicUserId) || !seguir() || !mesmaConta()) {
            log("rewarded_abortado_antes_de_exibir")
            return desistir(desafioId)
        }
        val resultado = exibir()
        if (resultado == RewardedResult.FECHADO_SEM_RECOMPENSA) {
            // The local reward may be missing or very late (LevelPlay documents the two callbacks as asynchronous),
            // but the signed server event may exist. The server is the authority: ask briefly, then give up and free the slot.
            log("rewarded_fechado_sem_reward_local: verificando o servidor")
            return if (verificarCurto(desafioId)) RewardedAttempt.CONFIRMADA else desistir(desafioId)
        }
        if (resultado != RewardedResult.RECOMPENSADO) {
            log("rewarded_sem_exibicao: $resultado")
            return desistir(desafioId)
        }
        repeat(tentativas) { i ->
            if (!mesmaConta()) {
                log("rewarded_conta_mudou_durante_a_espera")
                return desistir(desafioId) // the reward belongs to the other account: it cannot be claimed here
            }
            if (!seguir()) {
                log("rewarded_usuario_parou_de_esperar: pendente")
                return RewardedAttempt.PENDENTE
            }
            if (confirmada(desafioId) == true) {
                log("rewarded_confirmado_pelo_servidor tentativa=${i + 1}")
                return RewardedAttempt.CONFIRMADA
            }
            if (i < tentativas - 1) esperar(intervaloMs)
        }
        log("rewarded_callback_lento apos $tentativas consultas: pendente, sem cancelar")
        return RewardedAttempt.PENDENTE
    }

    /** True only if the server confirms within a short bounded window. A stop or account switch ends it as "no". */
    private suspend fun verificarCurto(desafioId: String): Boolean {
        repeat(tentativasVerificacao) { i ->
            if (!mesmaConta() || !seguir()) return false
            if (confirmada(desafioId) == true) {
                log("rewarded_confirmado_pelo_servidor_sem_reward_local tentativa=${i + 1}")
                return true
            }
            if (i < tentativasVerificacao - 1) esperar(intervaloVerificacaoMs)
        }
        return false
    }

    private suspend fun desistir(desafioId: String): RewardedAttempt {
        withContext(NonCancellable) { cancelar(desafioId) }
        return RewardedAttempt.NAO_CONFIRMADA
    }
}
