package com.nuvio.app.core.deeplink

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AppUrlBridgeTest {

    @Test
    fun `parses party invites from the app and the website`() {
        assertEquals(AppDeepLink.Party("K7M2QX"), parseAppDeepLink("nuvio://party/k7m-2qx"))
        assertEquals(AppDeepLink.Party("K7M2QX"), parseAppDeepLink("https://nuvio.tv/party/K7M2QX"))
        assertEquals(AppDeepLink.Party("K7M2QX"), parseAppDeepLink("https://NUVIO.tv/party/K7M2QX/"))
        assertNull(parseAppDeepLink("https://nuvio.tv/party/K7M2Q"))
        assertNull(parseAppDeepLink("https://nuvio.tv/link?code=K7M2QX"))
        assertNull(parseAppDeepLink("https://evil.example/party/K7M2QX"))
        assertNull(parseAppDeepLink("http://nuvio.tv/party/K7M2QX"))
    }

    @Test
    fun `parses existing notification meta deeplink`() {
        assertEquals(
            AppDeepLink.Meta(type = "series", id = "tt0944947"),
            parseAppDeepLink("nuvio://meta?type=series&id=tt0944947"),
        )
    }

    @Test
    fun `external links never install an addon`() {
        val manifest = "free.nebulapro.xyz/sports/i/free/manifest.json"
        assertNull(parseAppDeepLink("nuvio://$manifest"))
        assertNull(parseAppDeepLink("stremio://$manifest"))
        assertNull(parseAppDeepLink("https://$manifest"))
        assertNull(parseAppDeepLink("http://$manifest"))
        assertNull(parseAppDeepLink("stremio://192.168.0.10:7000/manifest.json"))
        assertNull(parseAppDeepLink("nuvio://localhost/manifest.json"))
    }

    @Test
    fun `legitimate internal links still work`() {
        assertEquals(AppDeepLink.Downloads, parseAppDeepLink(buildDownloadsDeepLinkUrl()))
        assertEquals(
            AppDeepLink.Meta(type = "series", id = "tt0944947"),
            parseAppDeepLink(buildMetaDeepLinkUrl(type = "series", id = "tt0944947")),
        )
    }

    @Test
    fun `parses direct imdb detail deeplink`() {
        assertEquals(
            AppDeepLink.Meta(type = "series", id = "tt0944947"),
            parseAppDeepLink("nuvio://series/tt0944947"),
        )
    }

    @Test
    fun `parses provider imdb detail deeplink`() {
        assertEquals(
            AppDeepLink.Meta(type = "series", id = "tt0944947"),
            parseAppDeepLink("nuvio://imdb/series/tt0944947"),
        )
    }

    @Test
    fun `parses provider tmdb detail deeplink`() {
        assertEquals(
            AppDeepLink.Meta(type = "series", id = "tmdb:1399"),
            parseAppDeepLink("nuvio://tmdb/tv/1399"),
        )
    }

    @Test
    fun `does not treat reserved auth link as addon install`() {
        assertNull(parseAppDeepLink("nuvio://auth/trakt?code=abc"))
    }

    @Test
    fun `does not treat non-host stremio link as addon install`() {
        assertNull(parseAppDeepLink("stremio://detail/series/tt0944947"))
    }
}
