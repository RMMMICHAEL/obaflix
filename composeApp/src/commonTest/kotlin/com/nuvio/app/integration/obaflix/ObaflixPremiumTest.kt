package com.nuvio.app.integration.obaflix

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ObaflixPremiumTest {
    private val plans = """{"planos":[
      {"id":"seja-premium","anunciosObrigatorios":false,"compravel":true,"precos":[
        {"id":"preco-seja-premium-30d","duracaoDias":30,"duracaoMeses":null,"precoCentavos":1000,"moeda":"BRL"}]}]}"""

    @Test
    fun theOfferAppearsOnlyWhenTheServerSaysTheAccountSeesAds() {
        assertEquals(true, ObaflixPremiumParse.adsRequired("""{"plano":{"id":"gratuito"},"anunciosObrigatorios":true}"""))
        assertEquals(false, ObaflixPremiumParse.adsRequired("""{"plano":{"id":"seja-premium"},"anunciosObrigatorios":false}""")) // no promotion, no empty space
        assertNull(ObaflixPremiumParse.adsRequired("""{"plano":{"id":"gratuito","nome":"Gratuito"}}""")) // old server: never offers
        assertNull(ObaflixPremiumParse.adsRequired("not json"))
    }

    @Test
    fun theOfferIsTheSejaPremiumPlanById() {
        val offer = assertNotNull(ObaflixPremiumParse.offer(plans))
        assertEquals("preco-seja-premium-30d", offer.planoPrecoId)
        assertEquals("R$ 10,00", offer.priceLabel)
        assertEquals("30 dias", offer.periodLabel)
        // another plan, even cheaper or named alike, is never the offer
        val other = """{"planos":[{"id":"basic","nome":"SEJA PREMIUM","anunciosObrigatorios":false,"compravel":true,"precos":[
          {"id":"preco-basic-30d","duracaoDias":30,"duracaoMeses":null,"precoCentavos":500,"moeda":"BRL"}]}]}"""
        assertNull(ObaflixPremiumParse.offer(other))
        // only the 30-day price qualifies
        val yearly = """{"planos":[{"id":"seja-premium","compravel":true,"precos":[
          {"id":"p-12m","duracaoDias":null,"duracaoMeses":12,"precoCentavos":9000,"moeda":"BRL"}]}]}"""
        assertNull(ObaflixPremiumParse.offer(yearly))
        assertNull(ObaflixPremiumParse.offer("not json"))
    }

    @Test
    fun theExistingPixOrderAnswerIsReadAndNothingIsGrantedByIt() {
        val created = ObaflixPremiumParse.createdOrder("""{"pedidoId":"p1","status":"AGUARDANDO","pix":{"copiaECola":"000201..."}}""")
        assertEquals("p1" to "000201...", created)
        assertNull(ObaflixPremiumParse.createdOrder("""{"error":"Pagamento temporariamente indisponível"}"""))
        assertEquals("Pagamento temporariamente indisponível", ObaflixPremiumParse.errorMessage("""{"error":"Pagamento temporariamente indisponível"}"""))
        assertEquals("PAGO", ObaflixPremiumParse.orderStatus("""{"id":"p1","status":"PAGO"}"""))
    }

    @Test
    fun theDemoFixtureCreatesNoCheckout() {
        val before = ObaflixPremium.demoMode
        try {
            ObaflixPremium.demoMode = true
            ObaflixPremium.toForm()
            assertEquals(PremiumCheckout.Sales, ObaflixPremium.checkout.value)
            ObaflixPremium.submit("52998224725", "11987654321", "x")
            assertEquals(PremiumCheckout.Sales, ObaflixPremium.checkout.value) // no order, nothing activated
        } finally {
            ObaflixPremium.demoMode = before
        }
    }

    @Test
    fun theGooglePlayBuildSellsNothingUntilItIsRegularized() {
        val before = ObaflixPremium.purchasesEnabled
        try {
            ObaflixPremium.purchasesEnabled = false
            ObaflixPremium.open()
            assertFalse(ObaflixPremium.pageOpen.value)
            ObaflixPremium.purchasesEnabled = true
            ObaflixPremium.open()
            assertTrue(ObaflixPremium.pageOpen.value)
        } finally {
            ObaflixPremium.close()
            ObaflixPremium.purchasesEnabled = before
        }
    }
}
