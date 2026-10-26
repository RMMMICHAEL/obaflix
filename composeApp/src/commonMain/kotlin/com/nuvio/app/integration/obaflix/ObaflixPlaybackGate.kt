package com.nuvio.app.integration.obaflix

import com.nuvio.app.core.auth.AuthRepository
import com.nuvio.app.features.addons.encodeAddonPathSegment
import io.ktor.http.decodeURLPart
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant

sealed interface GateDecision {
    data object Allowed : GateDecision
    data class Blocked(val message: String, val sessionRejected: Boolean = false) : GateDecision

    /** Server opened an ad challenge. Resolved inside [ObaflixPlaybackGate.authorize]; callers never see it. */
    data class AdRequired(val challengeId: String) : GateDecision
}

/** Shows the interstitial the server asked for; true only if it appeared and was dismissed. */
fun interface ObaflixAdPresenter {
    suspend fun show(): Boolean

    /**
     * Explicit user confirmation before the Interstitial opens (never automatic). [alternativaDoRewarded] is true when
     * the Rewarded was unavailable for a playback and the regular ad is offered in its place. Default: confirmed, so
     * presenters without UI (tests, headless) keep the old behaviour.
     */
    suspend fun confirmar(finalidade: String, alternativaDoRewarded: Boolean): Boolean = true
}

/** How a Rewarded attempt ended. Only [CONFIRMADA] may lead to `/api/ads/complete`. */
enum class RewardedAttempt {
    /** The server confirmed LevelPlay's signed event for this challenge. */
    CONFIRMADA,

    /** Nothing was reserved or shown: the challenge is untouched, the Interstitial may still serve it. */
    NAO_EXIBIDO,

    /** The Rewarded was reserved for this challenge but not confirmed: never answer it with a second ad. */
    NAO_CONFIRMADA,

    /**
     * The user finished the ad but the server's signed callback has not arrived yet (slow, up to minutes). The
     * reservation is kept, nothing is released and nothing is cancelled: the gate asks the server again later.
     */
    PENDENTE,
}

/** What the server says about a Rewarded the user already watched. */
enum class RewardStatus { CONFIRMADA, PENDENTE, EXPIRADA }

/** The user's explicit choice when the server asks for an ad. The two ads are alternatives, never both. */
enum class AdChoice { REWARDED, INTERSTITIAL, CANCELADO }

/** Voluntary Rewarded for playback. The local `onAdRewarded` never counts; only [RewardedAttempt.CONFIRMADA] does. */
interface ObaflixRewardedPresenter {
    /** The Rewarded can be offered for this build/account (not "already loaded": the flow awaits the load). */
    fun disponivel(): Boolean

    /** Starts identity + init + preload in the background. Never shows. */
    fun aquecer()

    /** One explicit confirmation to watch the Rewarded ([AdChoice.REWARDED]) or cancel. Never opens the ad by itself. */
    suspend fun escolher(): AdChoice

    suspend fun mostrar(desafioId: String): RewardedAttempt

    /** Asks the server again about a Rewarded that was left pending. */
    suspend fun consultar(desafioId: String): RewardStatus
}

class ObaflixPlaybackBlocked(message: String) : IllegalStateException(message)

/**
 * Every addon stream/subtitle request for Obaflix content passes here first: the backend decides
 * (session, rights, required ad) through `POST /api/playback/authorize`, and only then is the
 * canonical id translated for third-party addons. Fails closed on any unexpected answer.
 */
internal object ObaflixPlaybackGate {
    private val adDepth = kotlinx.coroutines.flow.MutableStateFlow(0)
    private val adFlag = kotlinx.coroutines.flow.MutableStateFlow(false)

    /** True while an ad is being asked for, shown or confirmed; callers' network budgets pause meanwhile. */
    val anuncioEmCurso: kotlinx.coroutines.flow.StateFlow<Boolean> get() = adFlag

    private fun adEnter() {
        adFlag.value = adDepth.updateAndGet { it + 1 } > 0
    }

    private fun adExit() {
        adFlag.value = adDepth.updateAndGet { maxOf(0, it - 1) } > 0
    }

    private val ttl = 60.seconds
    private val refusalTtl = 10.seconds

    /**
     * An answer with no ad proof means the server found this account exempt from ads (paid plan).
     * That fact is reused for a few minutes so a binge does not ask per episode. Only the server's own
     * answer feeds it, it is never persisted, and `/api/player/fontes` still checks the right on its own,
     * so a revoked plan loses the exemption within this window at most.
     */
    private val exemptTtl = 5.minutes
    private val exemptUntil = mutableMapOf<String, Instant>()

    internal var clock: () -> Instant = { Clock.System.now() }
    private val lock = Mutex()
    private val decisions = mutableMapOf<String, Pair<Instant, GateDecision>>()

    /** Single-use proof for `/api/player/fontes` (`passe` or post-ad `concessao`), per user/target/purpose. */
    private val tokens = mutableMapOf<String, String>()

    const val REPRODUCAO = "reproducao"
    const val DOWNLOAD = "download"
    const val TRANSMISSAO = "transmissao"

    /** Network seam, replaced in tests. Returns (status, body). */
    internal var post: suspend (String, String) -> Pair<Int, String> = { path, body ->
        ObaflixSession.authedRequest("POST", path, body).let { it.status to it.body }
    }

    /** Set by the Android host (MainActivity); null means no surface to show an ad on. */
    internal var adPresenter: ObaflixAdPresenter? = null

    /** Set by the Android host; null (or not [ObaflixRewardedPresenter.disponivel]) means the Interstitial path. */
    internal var rewardedPresenter: ObaflixRewardedPresenter? = null

    /** A Rewarded watched to the end whose server confirmation is still pending, one per account (the server allows one). */
    private class PendingReward(val key: String, val desafioId: String)
    private val pendentes = mutableMapOf<String, PendingReward>()

    private fun keyOf(userId: String, ref: ObaflixRef, finalidade: String) =
        "$userId|$finalidade|${ref.tipo}:${ref.id}:${ref.season}:${ref.episode}"

    suspend fun authorize(ref: ObaflixRef, finalidade: String = REPRODUCAO): GateDecision {
        val user = ObaflixSession.user ?: return GateDecision.Blocked(SIGN_IN, sessionRejected = true)
        val key = keyOf(user.userId, ref, finalidade)
        // One lock: concurrent addon fetches for the same title share a single authorize call.
        val decision = lock.withLock {
            val now = clock()
            decisions[key]?.takeIf { now < it.first }?.second ?: run {
                if (exemptUntil[user.userId]?.let { now < it } == true) return@run GateDecision.Allowed
                retomarPendente(ref, finalidade, key, user.userId)?.let { return@run it }
                val first = ask(ref, finalidade, key)
                // One ad lock: concurrent addon fetches wait here instead of opening a second challenge.
                val final = if (first is GateDecision.AdRequired) afterAd(ref, finalidade, key, first.challengeId) else first
                final.also { d ->
                    // Grants live 60 s; refusals only 10 s, enough to stop parallel addon fetches from
                    // opening one ad each, short enough that a retry asks the server again.
                    decisions[key] = now + (if (d == GateDecision.Allowed) ttl else refusalTtl) to d
                    if (d == GateDecision.Allowed && tokens[key] == null) exemptUntil[user.userId] = now + exemptTtl
                }
            }
        }
        if (decision is GateDecision.Blocked && decision.sessionRejected) {
            lock.withLock { exemptUntil.remove(user.userId) }
            AuthRepository.onObaflixSessionRejected()
        }
        return decision
    }

    /**
     * Rewrites `/stream|subtitles/<type>/obaflix:…` addon URLs to the title's IMDb id after the
     * gate allows it. Other URLs pass through untouched.
     */
    suspend fun rewriteAddonUrl(url: String): String {
        val match = OBAFLIX_RESOURCE.find(url) ?: return url
        val ref = ObaflixRef.parse(match.groupValues[2].decodeURLPart())
            ?: throw ObaflixPlaybackBlocked("Conteúdo inválido.")
        when (val d = authorize(ref)) {
            is GateDecision.Blocked -> throw ObaflixPlaybackBlocked(d.message)
            is GateDecision.AdRequired -> throw ObaflixPlaybackBlocked(UNAVAILABLE) // never returned by authorize
            GateDecision.Allowed -> Unit
        }
        val addonId = ObaflixCatalogAddon.addonVideoId(match.groupValues[2].decodeURLPart())
            ?: throw ObaflixPlaybackBlocked("Este título ainda não tem fontes de addons.")
        return url.replaceRange(match.groups[2]!!.range, addonId.encodeAddonPathSegment())
    }

    /** Takes the proof the last grant carried; null when there was none (exempt account) or it was used. */
    suspend fun takeToken(ref: ObaflixRef, finalidade: String = REPRODUCAO): String? {
        val user = ObaflixSession.user ?: return null
        return lock.withLock { tokens.remove(keyOf(user.userId, ref, finalidade)) }
    }

    /** Asks the server again (e.g. `/fontes` said the proof was missing or spent). Already-paid targets get a new pass. */
    suspend fun renew(ref: ObaflixRef, finalidade: String = REPRODUCAO): GateDecision {
        val user = ObaflixSession.user ?: return GateDecision.Blocked(SIGN_IN, sessionRejected = true)
        lock.withLock {
            decisions.remove(keyOf(user.userId, ref, finalidade))
            exemptUntil.remove(user.userId)
        }
        return authorize(ref, finalidade)
    }

    private suspend fun ask(ref: ObaflixRef, finalidade: String, key: String): GateDecision =
        runCatching { post("/api/playback/authorize", requestBody(ref, finalidade)) }
            .map { (status, body) ->
                parseDecision(status, body).also { if (it == GateDecision.Allowed) field(body, "passe")?.let { p -> tokens[key] = p } }
            }
            .getOrElse { e -> if (e is kotlinx.coroutines.CancellationException) throw e else GateDecision.Blocked(UNAVAILABLE) }

    /**
     * `/api/ads/complete` only issues the concession for a challenge the server opened, after its own
     * minimum time; then the target is marked paid and a fresh authorize must say PERMITIDO.
     * Nothing here grants playback by itself.
     */
    private suspend fun afterAd(ref: ObaflixRef, finalidade: String, key: String, challengeId: String): GateDecision {
        adEnter()
        try {
            return afterAdFlow(ref, finalidade, key, challengeId)
        } finally {
            adExit()
        }
    }

    private suspend fun afterAdFlow(ref: ObaflixRef, finalidade: String, key: String, challengeId: String): GateDecision {
        // The server found this account non-exempt; ads are contextual-only, so that is the needed right.
        ObaflixAdEligibility.confirm(true)
        // The S2S Rewarded exists only for playback (the server refuses `preparar` for other purposes). Download and cast
        // keep the Interstitial flow exactly as before: no question, no warm-up, no Rewarded.
        val soReproducao = finalidade == REPRODUCAO
        if (soReproducao) rewardedPresenter?.aquecer() // background warm-up for the next challenge; never shows

        // The Rewarded is offered only when this build/account can run it, and the user chooses explicitly. The two ads
        // are independent alternatives and never both: a Rewarded reserved for this challenge is never answered by an
        // Interstitial, and a regular Interstitial never follows a Rewarded.
        var viaInterstitial = true
        val rewarded = rewardedPresenter?.takeIf { soReproducao && runCatching { it.disponivel() }.getOrDefault(false) }
        if (rewarded != null) {
            val escolha = try {
                rewarded.escolher()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                AdChoice.CANCELADO
            }
            when (escolha) {
                AdChoice.CANCELADO -> return GateDecision.Blocked(AD_CANCELLED)
                AdChoice.INTERSTITIAL -> Unit
                AdChoice.REWARDED -> {
                    val tentativa = try {
                        rewarded.mostrar(challengeId)
                    } catch (e: kotlinx.coroutines.CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        RewardedAttempt.NAO_CONFIRMADA
                    }
                    when (tentativa) {
                        RewardedAttempt.CONFIRMADA -> viaInterstitial = false
                        RewardedAttempt.NAO_EXIBIDO -> return GateDecision.Blocked(AD_NOT_SHOWN)
                        RewardedAttempt.NAO_CONFIRMADA -> return GateDecision.Blocked(AD_NOT_CONFIRMED)
                        RewardedAttempt.PENDENTE -> {
                            ObaflixSession.user?.userId?.let { pendentes[it] = PendingReward(key, challengeId) }
                            return GateDecision.Blocked(AD_PENDING)
                        }
                    }
                }
            }
        }
        if (viaInterstitial) {
            val presenter = adPresenter ?: return GateDecision.Blocked(AD_UNAVAILABLE)
            // The regular ad never opens by itself: every purpose asks first, and for a playback whose Rewarded is
            // unavailable the question names the alternative.
            val confirmou = try {
                presenter.confirmar(finalidade, alternativaDoRewarded = soReproducao && rewardedPresenter != null)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                false
            }
            if (!confirmou) return GateDecision.Blocked(AD_CANCELLED)
            val shown = try {
                presenter.show()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                false
            }
            if (!shown) return GateDecision.Blocked(AD_UNAVAILABLE)
        }

        // Once the ad is done (and, for the Rewarded, the server confirmed it), the grant request must not be lost to the
        // caller's scope being cancelled: after a full-screen ad the Activity can be recreated (orientation), which cancels
        // the UI coroutine. The request is a single idempotent POST, so it runs to completion; the next playback request
        // then finds the target paid instead of asking for a second ad.
        val (status, body) = try {
            kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) {
                post("/api/ads/complete", completeBody(challengeId))
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            return GateDecision.Blocked(UNAVAILABLE)
        }
        when {
            status == 401 -> return GateDecision.Blocked(SIGN_IN, sessionRejected = true)
            status == 403 && "anuncio_nao_concluido" in body -> return GateDecision.Blocked(AD_NOT_FINISHED)
            status != 200 || "concessao" !in body -> return GateDecision.Blocked(UNAVAILABLE)
        }
        field(body, "concessao")?.let { tokens[key] = it } // a pass from the next authorize replaces it
        // A second challenge right after paying would loop; treat it as a failure instead.
        return when (val again = ask(ref, finalidade, key)) {
            is GateDecision.AdRequired -> GateDecision.Blocked(UNAVAILABLE)
            else -> again
        }
    }

    /**
     * A Rewarded the user finished but whose signed callback was slow: nothing was released and nothing cancelled, so
     * the next playback request asks the server again. Confirmed -> the same `/api/ads/complete` as always (the server
     * still requires its own receipt). Still pending -> keep waiting. Gone -> the normal flow starts over.
     */
    private suspend fun retomarPendente(ref: ObaflixRef, finalidade: String, key: String, userId: String): GateDecision? {
        val pendente = pendentes[userId] ?: return null
        val rewarded = rewardedPresenter
        if (rewarded == null) {
            pendentes.remove(userId)
            return null
        }
        val mesmo = pendente.key == key
        val estado = try {
            rewarded.consultar(pendente.desafioId)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            RewardStatus.PENDENTE // a failed query is never a reason to drop or grant
        }
        when (estado) {
            RewardStatus.EXPIRADA -> {
                pendentes.remove(userId)
                return null
            }
            RewardStatus.PENDENTE -> return if (mesmo) GateDecision.Blocked(AD_PENDING) else null
            RewardStatus.CONFIRMADA -> {
                pendentes.remove(userId)
                val (status, body) = try {
                    post("/api/ads/complete", completeBody(pendente.desafioId))
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (_: Exception) {
                    return if (mesmo) GateDecision.Blocked(UNAVAILABLE) else null
                }
                if (status != 200 || "concessao" !in body) return null // challenge expired meanwhile: start over
                field(body, "concessao")?.let { tokens[pendente.key] = it }
                if (!mesmo) return null // the reward paid for another title; this one goes through the normal flow
                return when (val again = ask(ref, finalidade, key)) {
                    is GateDecision.AdRequired -> GateDecision.Blocked(UNAVAILABLE)
                    else -> again
                }
            }
        }
    }

    internal fun completeBody(challengeId: String): String = buildJsonObject {
        put("desafioId", challengeId)
        put("concluido", true)
    }.toString()

    internal fun clear() {
        pendentes.clear()
        decisions.clear()
        tokens.clear()
        exemptUntil.clear()
    }

    private fun field(body: String, name: String): String? = runCatching {
        Json.parseToJsonElement(body).jsonObject[name]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
    }.getOrNull()

    internal fun requestBody(ref: ObaflixRef, finalidade: String = REPRODUCAO): String = buildJsonObject {
        put("conteudoId", ref.id)
        put("conteudoTipo", ref.tipo)
        if (ref.season != null) put("temporada", ref.season)
        if (ref.episode != null) put("numeroEp", ref.episode)
        put("plataforma", ObaflixConfig.PLATFORM)
        put("finalidade", finalidade)
    }.toString()

    internal fun parseDecision(status: Int, body: String): GateDecision {
        if (status == 401) return GateDecision.Blocked(SIGN_IN, sessionRejected = true)
        if (status != 200) return GateDecision.Blocked(UNAVAILABLE)
        val json = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()
            ?: return GateDecision.Blocked("Reprodução não liberada no momento.")
        return when (json["decisao"]?.jsonPrimitive?.contentOrNull) {
            "PERMITIDO" -> GateDecision.Allowed
            "ANUNCIO_NECESSARIO" -> json["desafioId"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
                ?.let { GateDecision.AdRequired(it) }
                ?: GateDecision.Blocked("Reprodução não liberada no momento.")
            "ANUNCIO_INDISPONIVEL" -> GateDecision.Blocked(AD_UNAVAILABLE)
            "NEGADO" -> GateDecision.Blocked("Este conteúdo não está disponível no seu plano.")
            else -> GateDecision.Blocked("Reprodução não liberada no momento.")
        }
    }

    private val OBAFLIX_RESOURCE = Regex("""/(stream|subtitles)/(?:movie|series)/(obaflix%3A[A-Za-z0-9_%\-]+)(?=[/.])""")
    private const val SIGN_IN = "Entre novamente na sua conta Obaflix."
    private const val UNAVAILABLE = "Não foi possível liberar a reprodução. Tente novamente."
    private const val AD_UNAVAILABLE = "Não foi possível exibir o anúncio agora. Tente novamente em instantes."
    private const val AD_PENDING = "Ainda estamos confirmando o seu anúncio. Tente reproduzir de novo em instantes."
    private const val AD_CANCELLED = "Reprodução cancelada."
    private const val AD_NOT_SHOWN = "O anúncio não foi exibido. Tente novamente."
    private const val AD_NOT_CONFIRMED = "Não conseguimos confirmar o anúncio. Tente novamente em instantes."
    private const val AD_NOT_FINISHED = "O anúncio foi fechado antes do tempo mínimo. Tente novamente e assista até o fim."
}
