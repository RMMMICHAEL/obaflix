package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.time.Clock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Set by the Android host: whether the consent form must stay reachable (UMP privacy options) and how to reopen it. */
internal object ObaflixAdPrivacy {
    var required: () -> Boolean = { false }
    var open: () -> Unit = {}
}

/**
 * Which ad network the server wants per format. Default is the current one (Unity Interstitial, LevelPlay Rewarded):
 * anything but an exact `"admob"` answer, a failure, a timeout or a signed-out account keeps it. The server only chooses;
 * the client still needs consent, an eligible account and an AdMob-enabled build before it touches the AdMob SDK.
 */
internal object ObaflixAdProviderChoice {
    data class Choice(val interstitialAdmob: Boolean = false, val rewardedAdmob: Boolean = false)

    val DEFAULT = Choice()

    @kotlin.concurrent.Volatile private var current: Choice = DEFAULT
    @kotlin.concurrent.Volatile private var userId: String? = null
    @kotlin.concurrent.Volatile private var fetchedAt = 0L

    /** Last known choice for the signed-in account; [DEFAULT] for anyone else (account switch, sign-out). */
    fun choice(): Choice = if (userId != null && userId == ObaflixSession.user?.userId) current else DEFAULT

    fun reset() {
        current = DEFAULT
        userId = null
        fetchedAt = 0L
    }

    internal fun parse(body: String): Choice = runCatching {
        val json = Json.parseToJsonElement(body).jsonObject
        Choice(
            interstitialAdmob = json["interstitial"]?.jsonPrimitive?.contentOrNull == "admob",
            rewardedAdmob = json["rewarded"]?.jsonPrimitive?.contentOrNull == "admob",
        )
    }.getOrDefault(DEFAULT)

    /** One bounded request per [TTL_MS] per account; any error settles on the default. Never throws (except cancellation). */
    suspend fun refresh(now: Long = Clock.System.now().toEpochMilliseconds()): Choice {
        val uid = ObaflixSession.user?.userId ?: return DEFAULT
        if (uid == userId && now - fetchedAt < TTL_MS) return current
        val answer = try {
            withTimeoutOrNull(TIMEOUT_MS) {
                val r = ObaflixSession.authedRequest("GET", "/api/ads/provedor")
                if (r.status == 200) parse(r.body) else DEFAULT
            } ?: DEFAULT
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            DEFAULT
        }
        if (ObaflixSession.user?.userId == uid) {
            current = answer
            userId = uid
            fetchedAt = now
        }
        return if (ObaflixSession.user?.userId == uid) answer else DEFAULT
    }

    private const val TTL_MS = 10 * 60 * 1000L
    private const val TIMEOUT_MS = 3_000L
}
