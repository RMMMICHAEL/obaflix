package com.nuvio.app.core.network

import kotlin.test.Test
import kotlin.test.assertEquals

class SafeLogHostTest {
    @Test fun dropsCredentialsPortPathQueryAndFragment() {
        assertEquals("obaflixbr.com", safeLogHost("https://alice:secret@obaflixbr.com:8443/private/token/manifest.json?api_key=secret#private"))
        assertEquals("addon.example", safeLogHost("http://user:secret@addon.example:8080/private/stream?token=secret#secret"))
    }

    @Test fun acceptsAddonSchemesAndSubdomains() {
        assertEquals("api.obaflixbr.com", safeLogHost("https://api.obaflixbr.com/private"))
        assertEquals("addon.example", safeLogHost("stremio://addon.example/private?token=secret"))
    }

    @Test fun supportsLocalAndIpv6HostsWithoutPort() {
        assertEquals("192.168.1.10", safeLogHost("http://192.168.1.10:8080/private?token=secret"))
        assertEquals("[::1]", safeLogHost("http://[::1]:8080/private?token=secret"))
    }

    @Test fun malformedInputsNeverFallBackToRawText() {
        listOf("", "secret/private?token=secret", "not a url", "https://bad%0Asecret.example/path", "https://bad\nsecret.example/path").forEach {
            assertEquals("<invalid-host>", safeLogHost(it), "Unsafe input must use a fixed placeholder")
        }
    }
}
