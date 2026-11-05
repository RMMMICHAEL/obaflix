package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The three Rewarded S2S routes of the Obaflix backend. None of them grants anything: the grant stays in
 * `/api/ads/complete`, which the playback gate calls only after [confirmada] says the server got LevelPlay's
 * signed callback. Anything unexpected is "no", never "yes".
 */
internal object ObaflixRewardedApi {
    sealed interface Preparo {
        data class Pronto(val dynamicUserId: String) : Preparo
        /** The account already has a Rewarded pending: nothing was reserved for this challenge. */
        data object EmAndamento : Preparo
        data object Indisponivel : Preparo
    }

    private val HEX32 = Regex("^[0-9a-f]{32}$")
    private val HEX48 = Regex("^[0-9a-f]{48}$")

    /** The opaque USER_ID the backend issued for this account; goes into `LevelPlayInitRequest.withUserId`. */
    suspend fun identidade(): String? = chamar("GET", "/api/ads/levelplay/identidade") { status, body ->
        if (status == 200) campo(body, "userId")?.takeIf { HEX32.matches(it) } else null
    }

    suspend fun preparar(desafioId: String): Preparo {
        val body = buildJsonObject { put("desafioId", desafioId) }.toString()
        return chamar("POST", "/api/ads/levelplay/preparar", body) { status, resposta ->
            when {
                status == 200 -> campo(resposta, "dynamicUserId")?.takeIf { HEX48.matches(it) }?.let { Preparo.Pronto(it) }
                status == 409 && "recompensa_em_andamento" in resposta -> Preparo.EmAndamento
                else -> null
            }
        } ?: Preparo.Indisponivel
    }

    /** `true` only when the server holds the verified receipt; `false` while pending; `null` on any error. */
    suspend fun confirmada(desafioId: String): Boolean? =
        chamar("GET", "/api/ads/levelplay/estado?desafioId=$desafioId") { status, body ->
            if (status != 200) null
            else runCatching { Json.parseToJsonElement(body).jsonObject["confirmada"]?.jsonPrimitive?.booleanOrNull }.getOrNull()
        }

    /** What the server knows about a Rewarded the user already watched: confirmed, still waiting, or gone. `null` on error. */
    suspend fun estado(desafioId: String): RewardStatus? =
        chamar("GET", "/api/ads/levelplay/estado?desafioId=$desafioId") { status, body ->
            if (status != 200) return@chamar null
            val json = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull() ?: return@chamar null
            val preparado = json["preparado"]?.jsonPrimitive?.booleanOrNull ?: return@chamar null
            val confirmada = json["confirmada"]?.jsonPrimitive?.booleanOrNull ?: return@chamar null
            when {
                confirmada -> RewardStatus.CONFIRMADA
                preparado -> RewardStatus.PENDENTE
                else -> RewardStatus.EXPIRADA
            }
        }

    /** Best effort: frees the account's pending Rewarded slot after a give-up. A failure only means it expires on its own. */
    suspend fun cancelar(desafioId: String) {
        val body = buildJsonObject { put("desafioId", desafioId) }.toString()
        chamar("POST", "/api/ads/levelplay/cancelar", body) { _, _ -> Unit }
    }

    private suspend fun <T> chamar(method: String, path: String, body: String = "", ler: (Int, String) -> T?): T? =
        try {
            val r = ObaflixSession.authedRequest(method, path, body)
            ler(r.status, r.body)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }

    private fun campo(body: String, nome: String): String? =
        runCatching { Json.parseToJsonElement(body).jsonObject[nome]?.jsonPrimitive?.contentOrNull }.getOrNull()
}
