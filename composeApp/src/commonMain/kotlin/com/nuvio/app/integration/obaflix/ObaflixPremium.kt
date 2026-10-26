package com.nuvio.app.integration.obaflix

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/** The cheapest ad-free offer of the server's public catalog: nothing here is hard-coded, price included. */
internal data class PremiumOffer(
    val planoPrecoId: String,
    val priceCents: Long,
    val days: Int?,
    val months: Int?,
) {
    val priceLabel: String
        get() = "R$ " + (priceCents / 100) + "," + (priceCents % 100).toString().padStart(2, '0')

    val periodLabel: String
        get() = when {
            days != null -> "$days dias"
            months == 12 -> "1 ano"
            months == 1 -> "1 mês"
            months != null -> "$months meses"
            else -> ""
        }
}

internal object ObaflixPremiumParse {
    private val json = Json { ignoreUnknownKeys = true }

    private fun planos(plansJson: String): List<JsonObject> = try {
        json.parseToJsonElement(plansJson).jsonObject["planos"]?.jsonArray?.map { it.jsonObject }.orEmpty()
    } catch (_: Exception) {
        emptyList()
    }

    /** The one plan the app sells; it is picked by this id, never by price or displayed name. */
    const val PLAN_ID = "seja-premium"

    /**
     * Whether this account still sees ads: the server's `anunciosObrigatorios` from `/api/billing/me`, computed from the
     * account's effective rights. Absent or unreadable -> null, and null never shows an offer.
     */
    fun adsRequired(meJson: String): Boolean? = try {
        json.parseToJsonElement(meJson).jsonObject["anunciosObrigatorios"]?.jsonPrimitive?.booleanOrNull
    } catch (_: Exception) {
        null
    }

    /** The 30-day BRL price of the [PLAN_ID] plan, from `/api/billing/plans?oferta=seja-premium`. Nothing else qualifies. */
    fun offer(plansJson: String): PremiumOffer? =
        planos(plansJson)
            .firstOrNull { it["id"]?.jsonPrimitive?.contentOrNull == PLAN_ID && it["compravel"]?.jsonPrimitive?.booleanOrNull == true }
            ?.get("precos")?.jsonArray?.map { it.jsonObject }.orEmpty()
            .filter { it["moeda"]?.jsonPrimitive?.contentOrNull == "BRL" && it["duracaoDias"]?.jsonPrimitive?.longOrNull == 30L }
            .mapNotNull { p ->
                val id = p["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val cents = p["precoCentavos"]?.jsonPrimitive?.longOrNull ?: return@mapNotNull null
                PremiumOffer(id, cents, 30, null)
            }
            .firstOrNull()

    fun errorMessage(body: String): String? = try {
        json.parseToJsonElement(body).jsonObject["error"]?.jsonPrimitive?.contentOrNull
    } catch (_: Exception) {
        null
    }
}

/** Server-side commercial rights for the signed-in account, loaded once per session and again after a payment. */
internal object ObaflixRights {
    private val _adsRequired = MutableStateFlow<Boolean?>(null)
    private val _offer = MutableStateFlow<PremiumOffer?>(null)
    private var loaded = false

    val adsRequired: StateFlow<Boolean?> get() = _adsRequired
    val offer: StateFlow<PremiumOffer?> get() = _offer

    /** Network seam, replaced in tests. */
    internal var get: suspend (String) -> Pair<Int, String> = { path ->
        ObaflixSession.authedRequest("GET", path).let { it.status to it.body }
    }

    suspend fun ensureLoaded() {
        if (!loaded) refresh()
    }

    suspend fun refresh() {
        if (ObaflixSession.user == null) return reset()
        val me = runCatching { get("/api/billing/me") }.getOrNull()
        val plans = runCatching { get("/api/billing/plans?oferta=${ObaflixPremiumParse.PLAN_ID}") }.getOrNull()
        if (me == null || plans == null || me.first != 200 || plans.first != 200) return // keep what we had
        loaded = true
        _adsRequired.value = ObaflixPremiumParse.adsRequired(me.second)
        // Visual homologation only: when the server has no offer yet, show a clearly marked demo one. It cannot pay.
        _offer.value = ObaflixPremiumParse.offer(plans.second) ?: if (ObaflixPremium.demoMode) PremiumOffer("demo", 1000, 30, null) else null
    }

    fun reset() {
        loaded = false
        _adsRequired.value = null
        _offer.value = null
    }
}

sealed interface PremiumCheckout {
    data object Sales : PremiumCheckout
    data class Form(val error: String? = null) : PremiumCheckout
    data object Creating : PremiumCheckout
    data class Waiting(val pixCode: String, val orderId: String) : PremiumCheckout
    data object Paid : PremiumCheckout
    data class Failed(val message: String) : PremiumCheckout
}

/** One Premium offer + the existing Pix checkout (`/api/billing/orders`). Nothing is granted here: only the server's answer. */
internal object ObaflixPremium {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var job: Job? = null

    private val _pageOpen = MutableStateFlow(false)
    private val _checkout = MutableStateFlow<PremiumCheckout>(PremiumCheckout.Sales)
    val pageOpen: StateFlow<Boolean> get() = _pageOpen
    val checkout: StateFlow<PremiumCheckout> get() = _checkout

    /**
     * Pix purchase is available in the direct APK. The Google Play distribution keeps it off until the alternative
     * billing program is confirmed for this app (set from the build; see [ObaflixPremiumParse] callers on Android).
     */
    @kotlin.concurrent.Volatile
    var purchasesEnabled: Boolean = true

    /**
     * Visual-homologation fixture (`-PobaflixPremiumDemo=true`, never in the Play flavor): shows the CTA and the sales page
     * with a demo offer so the layout can be checked before the plan exists on the server. Creates no order, changes no
     * right and activates nothing: the checkout is blocked while it is on.
     */
    @kotlin.concurrent.Volatile
    var demoMode: Boolean = false

    internal var request: suspend (String, String, String) -> Pair<Int, String> = { method, path, body ->
        ObaflixSession.authedRequest(method, path, body).let { it.status to it.body }
    }

    internal var pollDelayMs = 4_000L

    fun open() {
        if (!purchasesEnabled) return
        _pageOpen.value = true
    }

    fun close() {
        job?.cancel()
        _pageOpen.value = false
        _checkout.value = PremiumCheckout.Sales
    }

    fun toForm() {
        if (demoMode) return
        _checkout.value = PremiumCheckout.Form()
    }

    fun submit(document: String, phone: String, name: String) {
        if (demoMode) return
        val offer = ObaflixRights.offer.value ?: return
        val doc = document.filter { it.isDigit() }
        val tel = phone.filter { it.isDigit() }
        if (doc.length != 11 && doc.length != 14) return form("Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido.")
        if (tel.length !in 10..11) return form("Informe o telefone com DDD.")
        _checkout.value = PremiumCheckout.Creating
        job?.cancel()
        job = scope.launch {
            val body = buildJsonObject {
                put("planoId", ObaflixPremiumParse.PLAN_ID) // the order route needs both ids
                put("planoPrecoId", offer.planoPrecoId)
                put("documento", doc)
                put("telefone", tel)
                if (name.isNotBlank()) put("nome", name.trim())
            }.toString()
            val (status, text) = try {
                request("POST", "/api/billing/orders", body)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                return@launch form("Não foi possível iniciar o pagamento. Tente novamente.")
            }
            val created = if (status == 201) ObaflixPremiumParse.createdOrder(text) else null
            if (created == null) {
                return@launch form(ObaflixPremiumParse.errorMessage(text) ?: "Pagamento indisponível no momento.")
            }
            _checkout.value = PremiumCheckout.Waiting(created.second, created.first)
            poll(created.first)
        }
    }

    private fun form(message: String) {
        _checkout.value = PremiumCheckout.Form(message)
    }

    private suspend fun poll(orderId: String) {
        repeat(MAX_POLLS) {
            delay(pollDelayMs)
            val answer = runCatching { request("GET", "/api/billing/orders/$orderId", "") }.getOrNull() ?: return@repeat
            val state = ObaflixPremiumParse.orderStatus(answer.second)
            if (answer.first == 200 && state == "PAGO") {
                // Paid is only shown once the server's own rights say the ads are gone.
                repeat(5) {
                    ObaflixRights.refresh()
                    if (ObaflixRights.adsRequired.value == false) {
                        _checkout.value = PremiumCheckout.Paid
                        return
                    }
                    delay(pollDelayMs / 2)
                }
                _checkout.value = PremiumCheckout.Failed("Pagamento confirmado. Atualizando sua conta… reabra o app em instantes.")
                return
            }
            if (answer.first == 200 && state != null && state != "AGUARDANDO") {
                _checkout.value = PremiumCheckout.Failed("O pagamento não foi concluído. Você pode gerar um novo Pix.")
                return
            }
        }
        _checkout.value = PremiumCheckout.Failed("O Pix expirou. Gere um novo para continuar.")
    }

    private const val MAX_POLLS = 225 // ~15 min at 4 s
}

internal fun ObaflixPremiumParse.createdOrder(body: String): Pair<String, String>? = try {
    val o = Json.parseToJsonElement(body).jsonObject
    val id = o["pedidoId"]?.jsonPrimitive?.contentOrNull
    val code = o["pix"]?.jsonObject?.get("copiaECola")?.jsonPrimitive?.contentOrNull
    if (id != null && !code.isNullOrBlank()) id to code else null
} catch (_: Exception) {
    null
}

internal fun ObaflixPremiumParse.orderStatus(body: String): String? = try {
    Json.parseToJsonElement(body).jsonObject["status"]?.jsonPrimitive?.contentOrNull
} catch (_: Exception) {
    null
}
