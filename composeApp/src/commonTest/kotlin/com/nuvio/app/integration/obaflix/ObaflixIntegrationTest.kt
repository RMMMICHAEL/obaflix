package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.addons.AddonManifestParser
import com.nuvio.app.features.addons.RawHttpResponse
import com.nuvio.app.features.addons.buildAddonResourceUrl
import com.nuvio.app.features.addons.supportsResource
import com.nuvio.app.features.watchprogress.WatchProgressEntry
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ObaflixIntegrationTest {
    private val base = ObaflixConfig.CATALOG_BASE_URL
    private val manifestUrl = ObaflixConfig.CATALOG_ADDON_MANIFEST_URL
    private val requests = mutableListOf<String>()
    private var authorizeCalls = 0
    private var authorizeAnswer = 200 to """{"decisao":"PERMITIDO"}"""
    private val authorizeQueue = ArrayDeque<Pair<Int, String>>()
    private val completeBodies = mutableListOf<String>()
    private var completeAnswer = 200 to """{"concessao":"c1"}"""
    private var adShows = 0

    private val api = mapOf(
        "$base/api/tv/home" to """{"emAlta":[{"id":"66627589","titulo":"Obsessão","tipo":"filme"},{"id":"7485","titulo":"Mushoku Tensei","tipo":"anime"}],"popularesFilmes":[{"id":"66627589","titulo":"Obsessão","poster":"/p.jpg","background":"https://cdn.example/b.jpg","ano":2026,"nota":8.249,"generos":[{"genero":{"id":27,"nome":"Terror"}}]},{"titulo":"sem id"}]}""",
        "$base/api/filmes/66627589" to """{"id":"66627589","imdbId":"tt37287335","titulo":"Obsessão","duracao":100}""",
        "$base/api/filmes/1" to """{"id":"1","imdbId":null,"titulo":"Sem IMDb"}""",
        "$base/api/series/7485" to """{"id":"7485","imdbId":"tt13293588","titulo":"Mushoku Tensei","tipo":"anime"}""",
        "$base/api/series/7485/episodios" to """[{"id":"341518","temporada":1,"numeroEp":1,"titulo":"Ep 1","thumbnail":"/t.jpg","createdAt":"2026-06-22T23:10:46.601Z"},{"temporada":null,"numeroEp":2}]""",
        "$base/api/search?q=c%C3%A3o" to """{"filmes":[],"series":[{"id":"9","titulo":"Cão"}]}""",
        "$base/api/filmes?page=2" to """{"filmes":[{"id":"5","titulo":"Página 2"}]}""",
    )

    @BeforeTest
    fun setUp() {
        ObaflixCatalogAddon.clearCache()
        ObaflixPlaybackGate.clear()
        ObaflixCatalogAddon.fetch = { url -> requests += url; api[url] ?: error("unexpected $url") }
        ObaflixPlaybackGate.post = { path, body ->
            if (path == "/api/ads/complete") {
                completeBodies += body
                completeAnswer
            } else {
                authorizeCalls++
                authorizeQueue.removeFirstOrNull() ?: authorizeAnswer
            }
        }
        ObaflixPlaybackGate.adPresenter = null
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
    }

    private val realHttp = ObaflixSession.http

    @AfterTest
    fun tearDown() {
        ObaflixSession.http = realHttp
        ObaflixCatalogAddon.disk = null
        ObaflixCatalogAddon.onSharedRowsRefreshed = null
        ObaflixSession.current = null
        ObaflixPlaybackGate.adPresenter = null
    }

    private val adRequired = 200 to """{"decisao":"ANUNCIO_NECESSARIO","desafioId":"d1"}"""
    private val movieRef = ObaflixRef("filme", "66627589", null, null)

    private fun presenter(shown: Boolean) = ObaflixAdPresenter { adShows++; shown }

    @Test
    fun adFlowCompletesChallengeAndOnlyServerGrantReleases() = runTest {
        authorizeQueue += adRequired
        authorizeQueue += 200 to """{"decisao":"PERMITIDO","passe":"p"}"""
        ObaflixPlaybackGate.adPresenter = presenter(shown = true)

        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movieRef))
        assertEquals(1, adShows)
        assertEquals(2, authorizeCalls) // asked again after the concession
        val sent = Json.parseToJsonElement(completeBodies.single()).jsonObject
        assertEquals("d1", sent["desafioId"]!!.jsonPrimitive.content)
        // Grant reused: parallel addon fetches do not open a second ad.
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movieRef))
        assertEquals(1, adShows)
    }

    @Test
    fun exemptAccountNeverSeesAnAd() = runTest {
        ObaflixPlaybackGate.adPresenter = presenter(shown = true)
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.authorize(movieRef))
        assertEquals(0, adShows)
        assertTrue(completeBodies.isEmpty())
    }

    @Test
    fun adFailuresNeverReleaseMedia() = runTest {
        // No surface to show the ad on.
        authorizeAnswer = adRequired
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movieRef))
        assertTrue(completeBodies.isEmpty())

        // Ad could not be shown: challenge is not completed.
        ObaflixPlaybackGate.clear()
        ObaflixPlaybackGate.adPresenter = presenter(shown = false)
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movieRef))
        assertTrue(completeBodies.isEmpty())

        // Server refuses: closed before its minimum time.
        ObaflixPlaybackGate.clear()
        ObaflixPlaybackGate.adPresenter = presenter(shown = true)
        completeAnswer = 403 to """{"error":"Acesso negado","codigo":"anuncio_nao_concluido"}"""
        val early = ObaflixPlaybackGate.authorize(movieRef)
        assertIs<GateDecision.Blocked>(early)
        assertTrue("tempo mínimo" in early.message)

        // Concession issued but server still asks for an ad: no second ad, no release.
        ObaflixPlaybackGate.clear()
        completeAnswer = 200 to """{"concessao":"c"}"""
        val shownBefore = adShows
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movieRef))
        assertEquals(shownBefore + 1, adShows)

        // A refusal is remembered briefly so concurrent fetches do not stack ads.
        val callsBefore = authorizeCalls
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.authorize(movieRef))
        assertEquals(callsBefore, authorizeCalls)
    }

    @Test
    fun fenixflixIsDefaultAndLimitedToPlayback() {
        val url = "https://fenixflix.fenixhub.online/manifest.json"
        assertEquals(listOf(url), ObaflixConfig.DEFAULT_PLAYBACK_ADDON_URLS)
        val manifest = AddonManifestParser.parse(
            url,
            """{"id":"com.fenixflix","name":"FenixFlix","version":"1.2.5","types":["movie","series","anime"],
               "idPrefixes":["tt","tmdb","kitsu"],"resources":["stream","catalog"],
               "catalogs":[{"type":"movie","id":"top","name":"Top"}]}""",
        )
        assertTrue(manifest.catalogs.isEmpty())
        assertTrue(!manifest.supportsResource("catalog", "movie", "tt1"))
        assertTrue(manifest.supportsResource("stream", "movie", "obaflix:filme:1"))
    }

    @Test
    fun setCookieParsingKeepsExpiresCommasAndDropsDeletions() {
        val header = "__Host-next-auth.csrf-token=abc%7Cdef; Path=/; HttpOnly; Secure,__Secure-next-auth.session-token=jwt.v; Expires=Wed, 21 Oct 2026 10:00:00 GMT; Path=/,old=; Max-Age=0"
        assertEquals(
            mapOf("__Host-next-auth.csrf-token" to "abc%7Cdef", "__Secure-next-auth.session-token" to "jwt.v"),
            parseSetCookies(header),
        )
        assertTrue(isSessionCookie("__Secure-next-auth.session-token"))
        assertTrue(isSessionCookie("next-auth.session-token.0"))
        assertTrue(!isSessionCookie("__Host-next-auth.csrf-token"))
    }

    @Test
    fun sessionBodyMapsToUserOrNullWhenSignedOut() {
        assertEquals("u1" to "a@b.c", parseSessionUser("""{"user":{"id":"u1","email":"a@b.c"},"expires":"x"}"""))
        assertEquals("a@b.c" to "a@b.c", parseSessionUser("""{"user":{"email":"a@b.c"}}"""))
        assertNull(parseSessionUser("{}"))
        assertNull(parseSessionUser("not json"))
    }

    @Test
    fun refParsingAcceptsCanonicalIdsOnly() {
        assertEquals(ObaflixRef("filme", "1", null, null), ObaflixRef.parse("obaflix:filme:1"))
        assertEquals(ObaflixRef("serie", "7485", 1, 2), ObaflixRef.parse("obaflix:serie:7485:1:2"))
        listOf("tt123", "obaflix:filme:../x", "obaflix:canal:1", "obaflix:filme:1:1:1", "obaflix:serie:1:a:2", "obaflix:serie:1:-1:2")
            .forEach { assertNull(ObaflixRef.parse(it), it) }
    }

    @Test
    fun manifestIsAcceptedByNuvioParserAndKeepsCatalogAndMeta() {
        val manifest = AddonManifestParser.parse(manifestUrl, ObaflixCatalogAddon.manifest().toString())
        assertTrue(manifest.supportsResource("meta", "series", "obaflix:serie:7485"))
        assertTrue(manifest.catalogs.any { it.id == "obaflix.busca" && it.extra.any { e -> e.name == "search" && e.isRequired } })
    }

    @Test
    fun thirdPartyAddonsLoseCatalogsAndAcceptObaflixIdsOnlyWhenImdbKeyed() {
        val imdb = AddonManifestParser.parse(
            "https://addon.example/manifest.json",
            """{"id":"x","name":"X","version":"1","types":["movie"],"idPrefixes":["tt"],"resources":["catalog","meta","stream"],"catalogs":[{"type":"movie","id":"top","name":"Top"}]}""",
        )
        assertTrue(imdb.catalogs.isEmpty())
        assertTrue(!imdb.supportsResource("meta", "movie", "tt1"))
        assertTrue(imdb.supportsResource("stream", "movie", "obaflix:filme:1"))
        val kitsu = AddonManifestParser.parse(
            "https://anime.example/manifest.json",
            """{"id":"k","name":"K","version":"1","types":["series"],"idPrefixes":["kitsu:"],"resources":["stream"]}""",
        )
        assertTrue(!kitsu.supportsResource("stream", "series", "obaflix:serie:1:1:1"))
    }

    @Test
    fun homeCatalogMapsToMetaPreviewsWithCanonicalIdsAndImages() = runTest {
        val url = buildAddonResourceUrl(manifestUrl, "catalog", "movie", "obaflix.home.filmes.populares")
        assertTrue(ObaflixCatalogAddon.handles(url))
        val metas = Json.parseToJsonElement(ObaflixCatalogAddon.respond(url)).jsonObject["metas"]!!.jsonArray
        assertEquals(1, metas.size) // the row without id is dropped
        val m = metas[0].jsonObject
        assertEquals("obaflix:filme:66627589", m["id"]!!.jsonPrimitive.content)
        assertEquals("movie", m["type"]!!.jsonPrimitive.content)
        assertEquals("https://image.tmdb.org/t/p/w500/p.jpg", m["poster"]!!.jsonPrimitive.content)
        assertEquals("https://cdn.example/b.jpg", m["background"]!!.jsonPrimitive.content)
        assertEquals("8.2", m["imdbRating"]!!.jsonPrimitive.content)
        assertEquals("Terror", m["genres"]!!.jsonArray[0].jsonPrimitive.content)
    }

    @Test
    fun searchAndPagingUseObaflixApi() = runTest {
        val search = buildAddonResourceUrl(manifestUrl, "catalog", "series", "obaflix.busca", "search=c%C3%A3o")
        val found = Json.parseToJsonElement(ObaflixCatalogAddon.respond(search)).jsonObject["metas"]!!.jsonArray
        assertEquals("obaflix:serie:9", found.single().jsonObject["id"]!!.jsonPrimitive.content)
        val page = buildAddonResourceUrl(manifestUrl, "catalog", "movie", "obaflix.filmes", "skip=24")
        val paged = Json.parseToJsonElement(ObaflixCatalogAddon.respond(page)).jsonObject["metas"]!!.jsonArray
        assertEquals("obaflix:filme:5", paged.single().jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun seriesMetaListsEpisodesWithCanonicalVideoIds() = runTest {
        val url = buildAddonResourceUrl(manifestUrl, "meta", "series", "obaflix:serie:7485")
        val meta = Json.parseToJsonElement(ObaflixCatalogAddon.respond(url)).jsonObject["meta"]!!.jsonObject
        val video = meta["videos"]!!.jsonArray.single().jsonObject // invalid episode dropped
        assertEquals("obaflix:serie:7485:1:1", video["id"]!!.jsonPrimitive.content)
        assertEquals(1, video["season"]!!.jsonPrimitive.int)
        assertEquals("tt13293588", meta["imdb_id"]!!.jsonPrimitive.content)
    }

    @Test
    fun gateDecisionsFailClosed() {
        assertEquals(GateDecision.Allowed, ObaflixPlaybackGate.parseDecision(200, """{"decisao":"PERMITIDO","passe":"x"}"""))
        assertEquals(GateDecision.AdRequired("d"), ObaflixPlaybackGate.parseDecision(200, """{"decisao":"ANUNCIO_NECESSARIO","desafioId":"d"}"""))
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.parseDecision(200, """{"decisao":"ANUNCIO_NECESSARIO"}"""))
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.parseDecision(200, """{"decisao":"ANUNCIO_INDISPONIVEL","codigo":"x"}"""))
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.parseDecision(200, """{"decisao":"NEGADO"}"""))
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.parseDecision(503, """{"decisao":"PERMITIDO"}"""))
        assertIs<GateDecision.Blocked>(ObaflixPlaybackGate.parseDecision(200, "garbage"))
        assertTrue((ObaflixPlaybackGate.parseDecision(401, "") as GateDecision.Blocked).sessionRejected)
        val body = Json.parseToJsonElement(ObaflixPlaybackGate.requestBody(ObaflixRef("serie", "7485", 1, 2))).jsonObject
        assertEquals("serie", body["conteudoTipo"]!!.jsonPrimitive.content)
        assertEquals(2, body["numeroEp"]!!.jsonPrimitive.int)
        assertEquals("android_nativo", body["plataforma"]!!.jsonPrimitive.content)
        assertEquals("reproducao", body["finalidade"]!!.jsonPrimitive.content)
    }

    @Test
    fun addonStreamUrlIsAuthorizedOnceThenTranslatedToImdb() = runTest {
        val episode = buildAddonResourceUrl("https://addon.example/manifest.json", "stream", "series", "obaflix:serie:7485:1:2")
        assertEquals("https://addon.example/stream/series/tt13293588%3A1%3A2.json", ObaflixPlaybackGate.rewriteAddonUrl(episode))
        val subs = buildAddonResourceUrl("https://addon.example/manifest.json", "subtitles", "series", "obaflix:serie:7485:1:2")
        assertTrue(ObaflixPlaybackGate.rewriteAddonUrl(subs).contains("tt13293588"))
        assertEquals(1, authorizeCalls) // the grant is reused for 60 s
        val movie = buildAddonResourceUrl("https://addon.example/manifest.json", "stream", "movie", "obaflix:filme:66627589")
        assertEquals("https://addon.example/stream/movie/tt37287335.json", ObaflixPlaybackGate.rewriteAddonUrl(movie))
        val other = "https://addon.example/stream/movie/tt1.json"
        assertEquals(other, ObaflixPlaybackGate.rewriteAddonUrl(other))
    }

    @Test
    fun progressIsWrittenToObaflixHistoryWithEpisodeRowId() = runTest {
        val sent = mutableListOf<String>()
        ObaflixProgressSyncAdapter.remoteSyncEnabled = true
        ObaflixProgressSyncAdapter.post = { body -> sent += body; 200 }
        fun entry(videoId: String, parent: String, season: Int? = null, ep: Int? = null) = WatchProgressEntry(
            contentType = "series", parentMetaId = parent, parentMetaType = "series", videoId = videoId, title = "t",
            seasonNumber = season, episodeNumber = ep, lastPositionMs = 90_500, durationMs = 1_440_000, lastUpdatedEpochMs = 0,
        )
        ObaflixProgressSyncAdapter.push(1, listOf(
            entry("obaflix:serie:7485:1:1", "obaflix:serie:7485"),
            entry("tt1:1:1", "tt1"), // not Obaflix content: stays local
            entry("obaflix:serie:7485:9:9", "obaflix:serie:7485"), // unknown episode: skipped, never guessed
        ))
        val body = Json.parseToJsonElement(sent.single()).jsonObject
        assertEquals("7485", body["conteudoId"]!!.jsonPrimitive.content)
        assertEquals("341518", body["episodioId"]!!.jsonPrimitive.content)
        assertEquals(90, body["progressoSeg"]!!.jsonPrimitive.int)
        assertEquals(1440, body["duracaoSeg"]!!.jsonPrimitive.int)

        ObaflixProgressSyncAdapter.post = { 500 }
        assertFailsWith<IllegalStateException> {
            ObaflixProgressSyncAdapter.push(1, listOf(entry("obaflix:serie:7485:1:1", "obaflix:serie:7485")))
        }
        ObaflixProgressSyncAdapter.remoteSyncEnabled = false
    }

    @Test
    fun blockedOrUnmappableContentNeverReachesAddons() = runTest {
        val noImdb = buildAddonResourceUrl("https://addon.example/manifest.json", "stream", "movie", "obaflix:filme:1")
        assertFailsWith<ObaflixPlaybackBlocked> { ObaflixPlaybackGate.rewriteAddonUrl(noImdb) }

        ObaflixPlaybackGate.clear() // the exempt window of the account above is over: the server decides afresh
        authorizeAnswer = 200 to """{"decisao":"ANUNCIO_NECESSARIO","desafioId":"d"}"""
        val movie = buildAddonResourceUrl("https://addon.example/manifest.json", "stream", "movie", "obaflix:filme:66627589")
        assertFailsWith<ObaflixPlaybackBlocked> { ObaflixPlaybackGate.rewriteAddonUrl(movie) }
        assertFailsWith<ObaflixPlaybackBlocked> { ObaflixPlaybackGate.rewriteAddonUrl(movie) }
        assertEquals(2, authorizeCalls) // refusal kept 10 s: no ad storm from parallel fetches

        ObaflixSession.current = null
        authorizeCalls = 0
        assertFailsWith<ObaflixPlaybackBlocked> { ObaflixPlaybackGate.rewriteAddonUrl(movie) }
        assertEquals(0, authorizeCalls) // no session: refused locally, nothing sent
    }

    @Test
    fun homeFollowsElectronOrderAndTrendingMixesFilmsAndSeries() = runTest {
        val home = ObaflixCatalogAddon.manifest()["catalogs"]!!.jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content }
            .filter { ObaflixCatalogAddon.isHomeRow(ObaflixCatalogAddon.MANIFEST_ID, it) }
        assertEquals(
            listOf("emalta", "filmes.populares", "filmes.top10", "filmes.avaliados", "series.populares", "series.top10",
                "series.avaliadas", "animes.populares", "animes.avaliados", "parati", "porquegostou", "animeradar", "dublados"),
            home.map { it.removePrefix(ObaflixCatalogAddon.HOME_PREFIX) },
        )
        assertTrue(!ObaflixCatalogAddon.isHomeRow(ObaflixCatalogAddon.MANIFEST_ID, "obaflix.filmes.populares")) // Descobrir only
        assertTrue(ObaflixCatalogAddon.isHomeRow("other.addon", "anything"))

        val url = buildAddonResourceUrl(manifestUrl, "catalog", "movie", ObaflixCatalogAddon.TRENDING_ID)
        val metas = Json.parseToJsonElement(ObaflixCatalogAddon.respond(url)).jsonObject["metas"]!!.jsonArray
        assertEquals(listOf("obaflix:filme:66627589", "obaflix:serie:7485"), metas.map { it.jsonObject["id"]!!.jsonPrimitive.content })
        assertEquals(listOf("movie", "series"), metas.map { it.jsonObject["type"]!!.jsonPrimitive.content })
        ObaflixCatalogAddon.respond(buildAddonResourceUrl(manifestUrl, "catalog", "movie", "obaflix.home.filmes.top10"))
        assertEquals(1, requests.count { it == "$base/api/tv/home" }) // every ranked row shares one cached request
    }

    @Test
    fun everyCallIdentifiesTheNativeApp() = runTest {
        val seen = mutableListOf<Map<String, String>>()
        ObaflixSession.http = { _, url, headers, _ ->
            seen += headers
            RawHttpResponse(200, "OK", url, "{}", emptyMap())
        }
        ObaflixSession.authedRequest("GET", "/api/recommendations")
        assertEquals("android-nativo", seen.single()["X-Obaflix-Client"])
        assertTrue(seen.single()["User-Agent"]!!.startsWith("ObaflixNative/"))
        assertEquals("android_nativo", ObaflixConfig.PLATFORM)
    }

    @Test
    fun personalRowsComeFromOneSignedInRecommendationsCall() = runTest {
        val calls = mutableListOf<Pair<String, String?>>()
        ObaflixSession.http = { method, url, headers, _ ->
            calls += url to headers["Cookie"]
            RawHttpResponse(200, "OK", url, """{"rows":[{"id":"for-you","titulo":"Escolhidos para você","items":[{"id":"5","tipo":"filme","titulo":"A"},{"id":"9","tipo":"anime","titulo":"B"}]},{"id":"dubbed","titulo":"Dublados","items":[{"id":"7","tipo":"serie","titulo":"C"}]}]}""", emptyMap())
        }
        suspend fun ids(id: String) = Json.parseToJsonElement(ObaflixCatalogAddon.respond(buildAddonResourceUrl(manifestUrl, "catalog", "movie", id)))
            .jsonObject["metas"]!!.jsonArray.map { it.jsonObject["id"]!!.jsonPrimitive.content }
        assertEquals(listOf("obaflix:filme:5", "obaflix:serie:9"), ids("obaflix.home.parati"))
        assertEquals(listOf("obaflix:serie:7"), ids("obaflix.home.dublados"))
        assertEquals(emptyList(), ids("obaflix.home.porquegostou")) // no such row for this account: hidden
        assertEquals(1, calls.size)
        assertEquals("${ObaflixConfig.BASE_URL}/api/recommendations", calls.single().first)
        assertTrue(calls.single().second!!.contains("session-token"))

        ObaflixSession.current = null
        ObaflixCatalogAddon.clearCache()
        assertEquals(emptyList(), ids("obaflix.home.parati")) // signed out: no call, no row
        assertEquals(1, calls.size)
    }

    @Test
    fun rowsLoadingTogetherShareOneRequest() = runTest {
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        ObaflixCatalogAddon.fetch = { url -> requests += url; gate.await(); api[url] ?: error("unexpected $url") }
        val rows = listOf("emalta", "filmes.populares", "filmes.top10", "filmes.avaliados").map { id ->
            async(kotlinx.coroutines.Dispatchers.Default) {
                ObaflixCatalogAddon.respond(buildAddonResourceUrl(manifestUrl, "catalog", "movie", ObaflixCatalogAddon.HOME_PREFIX + id))
            }
        }
        while (requests.isEmpty()) kotlinx.coroutines.yield()
        gate.complete(Unit)
        rows.awaitAll()
        assertEquals(listOf("$base/api/tv/home"), requests) // 4 rows, 1 call
    }

    @Test
    fun coldStartShowsDiskRankingAtOnceAndRefreshesIt() = runTest {
        val stored = mutableMapOf(ObaflixCatalogAddon.diskKey("/api/tv/home") to """{"emAlta":[{"id":"1","titulo":"Ontem","tipo":"filme"}]}""")
        ObaflixCatalogAddon.disk = object : ObaflixDiskCache {
            override fun read(key: String) = stored[key]
            override fun write(key: String, value: String) { stored[key] = value }
        }
        val refreshed = kotlinx.coroutines.CompletableDeferred<Unit>()
        ObaflixCatalogAddon.onSharedRowsRefreshed = { refreshed.complete(Unit) }
        suspend fun trending() = Json.parseToJsonElement(ObaflixCatalogAddon.respond(
            buildAddonResourceUrl(manifestUrl, "catalog", "movie", ObaflixCatalogAddon.TRENDING_ID),
        )).jsonObject["metas"]!!.jsonArray.map { it.jsonObject["name"]!!.jsonPrimitive.content }

        assertEquals(listOf("Ontem"), trending()) // instant, from disk
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) { refreshed.await() }
        assertEquals(listOf("Obsessão", "Mushoku Tensei"), trending()) // fresh ranking, from memory
        assertTrue(stored[ObaflixCatalogAddon.diskKey("/api/tv/home")]!!.contains("Mushoku")) // and saved for the next start
        assertEquals(1, requests.count { it == "$base/api/tv/home" })
    }

    @Test
    fun homeRowTitlesHaveNoTypeSuffix() {
        val addon = com.nuvio.app.features.addons.ManagedAddon(
            manifestUrl = manifestUrl,
            manifest = AddonManifestParser.parse(manifestUrl, ObaflixCatalogAddon.manifest().toString()),
        )
        val rows = com.nuvio.app.features.home.buildHomeCatalogDefinitions(listOf(addon))
            .filter { it.manifestUrl == manifestUrl }
        assertEquals("Em alta", rows.first().titleFor(showCatalogType = true))
        assertTrue(rows.isNotEmpty() && rows.all { it.titleFor(showCatalogType = true) == it.catalogName }, rows.map { it.defaultTitle }.toString())
        assertTrue(rows.none { it.titleFor(true).endsWith(" - Filmes") || it.titleFor(true).endsWith(" - Séries") })
        assertEquals(rows.size, rows.map { "${it.type}:${it.catalogId}" }.distinct().size) // identity and filters untouched
    }
}
