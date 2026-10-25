package com.nuvio.app.integration.obaflix

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ObaflixLegalLinksTest {
    @Test
    fun legalAndDeletionLinksPointToTheExistingSitePagesOverHttps() {
        assertEquals("https://obaflixbr.com/privacidade", ObaflixConfig.PRIVACY_URL)
        assertEquals("https://obaflixbr.com/termos", ObaflixConfig.TERMS_URL)
        assertEquals("https://obaflixbr.com/excluir-conta", ObaflixConfig.DELETE_ACCOUNT_URL)
        listOf(ObaflixConfig.PRIVACY_URL, ObaflixConfig.TERMS_URL, ObaflixConfig.DELETE_ACCOUNT_URL)
            .forEach { assertTrue(it.startsWith(ObaflixConfig.BASE_URL + "/")) }
    }
}
