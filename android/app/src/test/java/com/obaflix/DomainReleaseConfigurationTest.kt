package com.obaflix

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DomainReleaseConfigurationTest {
    @Test
    fun `atualizacao mantem identidade e dominio compartilhado`() {
        assertEquals("com.obaflix", BuildConfig.APPLICATION_ID)
        assertEquals(24, BuildConfig.VERSION_CODE)
        assertEquals("1.0.24", BuildConfig.VERSION_NAME)
        assertEquals("https://obaflixbr.com", BuildConfig.OBAFLIX_URL)
        assertEquals(BuildConfig.OBAFLIX_URL, com.obaflix.core.BuildConfig.OBAFLIX_URL)
        assertTrue(com.obaflix.core.BuildConfig.ALLOWED_SIGNING_CERTS_SHA256
            .split(',').contains("bdf64ebf3cc9f841a05d4a60d67c39bc957f69c0f4fd6b66c0465901f6a0de04"))
    }

    @Test
    fun `distribuicao direta preserva atualizador e Play permanece desligado`() {
        assertEquals(
            if (BuildConfig.PLAY_STORE_BUILD) "" else "https://app.obaflix.online/update-manifest.json",
            BuildConfig.UPDATE_MANIFEST_URL,
        )
    }
}
