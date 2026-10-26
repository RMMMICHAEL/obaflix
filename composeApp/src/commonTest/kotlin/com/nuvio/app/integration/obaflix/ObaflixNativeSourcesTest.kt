package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.player.nextObaflixCandidate
import com.nuvio.app.features.player.obaflixAttemptKey
import com.nuvio.app.features.player.obaflixSourceLabel
import com.nuvio.app.features.player.OBAFLIX_SOURCES_EXHAUSTED
import com.nuvio.app.features.player.OBAFLIX_INITIAL_STALL_MS
import com.nuvio.app.features.servers.ServerException
import com.nuvio.app.features.servers.ServerFailure
import com.nuvio.app.features.streams.AddonStreamGroup
import com.nuvio.app.features.streams.StreamItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ObaflixNativeSourcesTest {
    private val movie = ObaflixRef("filme", "66627589", null, null)
    private val authorizeAnswers = ArrayDeque<Pair<Int, String>>()
    private var authorizeCalls = 0
    private val authorizeBodies = mutableListOf<String>()
    private val nativeCalls = mutableListOf<Pair<String, String>>()
    private val nativeAnswers = ArrayDeque<Pair<Int, String>>()
    private val extracted = mutableListOf<String>()

    private val fontes = """{"sessao":"s1","fontes":[
        {"id":"a","rotulo":"Servidor 1","idioma":"dub","disponivel":true,"nativo":true},
        {"id":"b","rotulo":"Servidor 2","disponivel":true,"resolvidoNoServidor":true},
        {"id":"c","rotulo":"Servidor 3","disponivel":true,"nativo":true,"iframeDesafio":true},
        {"id":"d","rotulo":"Servidor 4","disponivel":false,"nativo":true},
        {"id":"e","rotulo":"Servidor 5","disponivel":true},
        {"rotulo":"sem id","disponivel":true,"nativo":true}]}"""

    @BeforeTest
    fun setUp() {
        ObaflixPlaybackGate.clear()
        ObaflixSession.current = ObaflixStoredSession(mapOf("__Secure-next-auth.session-token" to "jwt"), "u1", "a@b.c")
        ObaflixPlaybackGate.post = { _, body ->
            authorizeCalls++
            authorizeBodies += body
            authorizeAnswers.removeFirstOrNull() ?: (200 to """{"decisao":"PERMITIDO"}""")
        }
        ObaflixNativeSources.post = { path, body ->
            nativeCalls += path to body
            nativeAnswers.removeFirst()
        }
        ObaflixNativeSources.extractor = { embed ->
            extracted += embed
            if ("dead" in embed) error("provider down")
            ExtractedMedia("https://cdn.example/master.txt?t=1", "https://embed.example/", "UA/1", isHls = true)
        }
    }

    @AfterTest
    fun tearDown() {
        ObaflixSession.current = null
        ObaflixNativeSources.extractor = null
    }

    private fun json(body: String) = Json.parseToJsonElement(body).jsonObject

    @Test
    fun listUsesSingleUseProofAndOffersOnlyNativeCapableServers() = runTest {
        authorizeAnswers += 200 to """{"decisao":"PERMITIDO","passe":"p1"}"""
        nativeAnswers += 200 to fontes

        val servers = ObaflixNativeSources.list(movie)

        assertEquals(listOf("Servidor 1 · Dublado", "Servidor 2"), servers.map { it.name })
        assertTrue(servers.all { ObaflixNative.isNative(it) && it.addonId == ObaflixNative.GROUP_ID && it.url == null })
        val body = json(nativeCalls.single().second)
        assertEquals("p1", body["concessao"]!!.jsonPrimitive.content)
        assertEquals("android", body["ambiente"]!!.jsonPrimitive.content)
        assertEquals("android_nativo", body["plataforma"]!!.jsonPrimitive.content)
        assertEquals("false", body["desafioInterativo"]!!.jsonPrimitive.content)
        assertNull(ObaflixPlaybackGate.takeToken(movie)) // spent
    }

    @Test
    fun spentProofIsRenewedOnceWithoutSecondAd() = runTest {
        authorizeAnswers += 200 to """{"decisao":"PERMITIDO"}"""
        authorizeAnswers += 200 to """{"decisao":"PERMITIDO","passe":"p2"}"""
        nativeAnswers += 403 to """{"codigo":"anuncio_necessario"}"""
        nativeAnswers += 200 to fontes

        assertEquals(2, ObaflixNativeSources.list(movie).size)
        assertEquals(2, authorizeCalls)
        assertNull(json(nativeCalls[0].second)["concessao"])
        assertEquals("p2", json(nativeCalls[1].second)["concessao"]!!.jsonPrimitive.content)
    }

    @Test
    fun blockedPlaybackNeverOpensServerSession() = runTest {
        authorizeAnswers += 200 to """{"decisao":"NEGADO"}"""
        assertFailsWith<ServerException> { ObaflixNativeSources.list(movie) }
        assertTrue(nativeCalls.isEmpty())

        ObaflixPlaybackGate.clear()
        nativeAnswers += 401 to "{}"
        val e = assertFailsWith<ServerException> { ObaflixNativeSources.list(movie) }
        assertEquals(ServerFailure.AUTH_REQUIRED, e.failure)
    }

    @Test
    fun prepareWalksCoordinatesAndExtractsOnDevice() = runTest {
        authorizeAnswers += 200 to """{"decisao":"PERMITIDO"}"""
        nativeAnswers += 200 to fontes
        val server = ObaflixNativeSources.list(movie).first()
        nativeAnswers += 200 to """{"embedUrl":"https://dead.example/e/1","tentativas":3}"""
        nativeAnswers += 200 to """{"embedUrl":"https://ok.example/e/1","tentativas":3,"legendas":[{"url":"https://s.example/pt.vtt","label":"PT"},{"url":"http://insecure/x.vtt"}]}"""

        val ready = ObaflixNativeSources.prepare(server)

        assertEquals("https://cdn.example/master.txt?t=1", ready.url)
        assertEquals("hls", ready.streamType)
        assertEquals(mapOf("Referer" to "https://embed.example/", "User-Agent" to "UA/1"), ready.behaviorHints.proxyHeaders?.request)
        assertEquals(listOf("https://s.example/pt.vtt"), ready.externalSubtitles.map { it.url })
        assertEquals(listOf("https://dead.example/e/1", "https://ok.example/e/1"), extracted)
        val second = json(nativeCalls.last().second)
        assertEquals("s1", second["sessao"]!!.jsonPrimitive.content)
        assertEquals(1, second["tentativa"]!!.jsonPrimitive.content.toInt())
    }

    @Test
    fun prepareRejectsInsecureMediaAndExpiredSessions() = runTest {
        authorizeAnswers += 200 to """{"decisao":"PERMITIDO"}"""
        nativeAnswers += 200 to fontes
        val server = ObaflixNativeSources.list(movie)[1]
        nativeAnswers += 200 to """{"streamUrl":"http://cdn.example/a.mp4"}"""
        assertFailsWith<ServerException> { ObaflixNativeSources.prepare(server) }

        nativeAnswers += 403 to """{"codigo":"sessao_invalida"}"""
        assertFailsWith<ServerException> { ObaflixNativeSources.prepare(server) }

        nativeAnswers += 200 to """{"streamUrl":"https://cdn.example/a.mp4","referer":"https://r.example/"}"""
        val ready = ObaflixNativeSources.prepare(server)
        assertEquals("https://cdn.example/a.mp4", ready.url)
        assertTrue(extracted.isEmpty()) // server-resolved media is not re-extracted
    }

    @Test
    fun failoverPrefersAddonsThenNativeAndNeverRepeats() {
        fun s(addon: String, url: String?) = StreamItem(name = url, url = url, addonName = addon, addonId = addon)
        val native = StreamItem(
            name = "Servidor 1", addonName = ObaflixNative.LABEL, addonId = ObaflixNative.GROUP_ID,
            serverTarget = com.nuvio.app.features.servers.ServerPlaybackTarget(
                com.nuvio.app.features.servers.ServerItemRef(ObaflixNative.CONNECTION_ID, "s1"), "a",
            ),
        )
        val groups = listOf(
            AddonStreamGroup(ObaflixNative.LABEL, ObaflixNative.GROUP_ID, listOf(native), isLoading = false),
            AddonStreamGroup("FenixFlix", "fenix", listOf(s("fenix", "https://a/1"), s("fenix", "https://a/2")), isLoading = false),
        )
        val first = nextObaflixCandidate(groups, emptySet())!!
        assertEquals("https://a/1", first.url)
        val second = nextObaflixCandidate(groups, setOf(first.obaflixAttemptKey()))!!
        assertEquals("https://a/2", second.url)
        val third = nextObaflixCandidate(groups, setOf(first.obaflixAttemptKey(), second.obaflixAttemptKey()))!!
        assertTrue(ObaflixNative.isNative(third))
        assertNull(nextObaflixCandidate(groups, setOf(first, second, third).map { it.obaflixAttemptKey() }.toSet()))
    }

    @Test
    fun activeSourceIsIdentifiedByCategoryAndPublicLabelOnly() {
        assertEquals("Fonte Nativa · Servidor 2 · Dublado", obaflixSourceLabel(ObaflixNative.GROUP_ID, ObaflixNative.LABEL, "Servidor 2 · Dublado"))
        assertEquals("Addon · FenixFlix", obaflixSourceLabel("fenix", "FenixFlix", "https://cdn.example/secret?token=x"))
        assertEquals("Fonte Nativa", obaflixSourceLabel(ObaflixNative.GROUP_ID, ObaflixNative.LABEL, null))
        assertTrue("http" !in obaflixSourceLabel("fenix", "FenixFlix", "https://cdn.example/a"))
        assertTrue(OBAFLIX_SOURCES_EXHAUSTED.startsWith("Nenhuma fonte"))
        assertTrue(OBAFLIX_INITIAL_STALL_MS in 15_000L..45_000L)
    }

    @Test
    fun downloadIsAuthorizedPerActionWithItsOwnPurpose() = runTest {
        val started = mutableListOf<StreamItem>()
        val scope = TestScope(StandardTestDispatcher(testScheduler))
        val action = obaflixDownloadGate("obaflix:filme:66627589", scope) { started += it }
        val addonStream = StreamItem(url = "https://a/1.mp4", addonName = "FenixFlix", addonId = "fenix")

        action(addonStream)
        action(addonStream)
        scope.advanceUntilIdle()
        assertEquals(2, started.size)
        assertEquals(2, authorizeCalls) // no grant reuse between downloads
        assertTrue(authorizeBodies.all { json(it)["finalidade"]!!.jsonPrimitive.content == "download" })

        authorizeAnswers += 200 to """{"decisao":"NEGADO"}"""
        action(addonStream)
        scope.advanceUntilIdle()
        assertEquals(2, started.size)

        val native = StreamItem(
            addonName = ObaflixNative.LABEL, addonId = ObaflixNative.GROUP_ID,
            serverTarget = com.nuvio.app.features.servers.ServerPlaybackTarget(
                com.nuvio.app.features.servers.ServerItemRef(ObaflixNative.CONNECTION_ID, "s1"), "a",
            ),
        )
        action(native)
        scope.advanceUntilIdle()
        assertEquals(2, started.size)

        // Non-Obaflix content keeps Nuvio's own behaviour.
        val plain = obaflixDownloadGate("tt123", CoroutineScope(Dispatchers.Unconfined)) { started += it }
        plain(addonStream)
        assertEquals(3, started.size)
    }
}
