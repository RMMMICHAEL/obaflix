package com.obaflix.bridge

import com.obaflix.ObaflixApp
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Regressão do 403 do POST legado do embedplayer (Fire Player).
 *
 * O HAR real do Obaflix mostra GET /video/<id> 200 seguido de POST
 * /player/index.php?...&do=getVideo 403 — sem nada depois disso. O Electron já
 * corrigiu isso (commit abd2859): esse 403 pertence à FONTE, não à autorização
 * Superflix, e não pode abortar o failover. Este teste prova o mesmo
 * comportamento em SuperflixExtractor.Session.resolveWithFailover(): a
 * candidata que 403 é rejeitada normalmente, e a próxima opção do bootstrap —
 * já exposta, nunca colapsada — é tentada em seguida.
 *
 * Roda contra um MockWebServer local; nenhuma requisição sai para a rede real,
 * nenhum host de produção é tocado.
 */
class SuperflixEmbedplayerFailoverTest {

    private lateinit var server: MockWebServer

    @Before
    fun subir() {
        server = MockWebServer()
        server.start()
        // extractEmbedPlayer() usa este cliente diretamente, fora do que
        // Session recebe por parâmetro — sem isso o POST ao /player/index.php
        // sairia para a internet de verdade.
        ObaflixApp.httpClient = clienteApontandoParaMock()
    }

    @After
    fun descer() {
        server.shutdown()
    }

    /**
     * postSource()/resolveSource()/extractEmbedPlayer() derivam a origem via
     * `URL.host`, que em Java NUNCA inclui a porta — em produção não importa
     * (host real sempre usa a porta padrão do esquema), mas contra um
     * MockWebServer numa porta aleatória isso perde exatamente a porta que
     * importa. Em vez de mudar código de produção só para caber num teste,
     * este interceptor força toda conexão de volta ao mock, não importa que
     * host/porta a URL calculada tenha.
     */
    private fun clienteApontandoParaMock(): OkHttpClient {
        val redireciona = Interceptor { chain ->
            val original = chain.request()
            val redirecionada = original.url.newBuilder()
                .host("127.0.0.1")
                .port(server.port)
                .build()
            chain.proceed(original.newBuilder().url(redirecionada).build())
        }
        return OkHttpClient.Builder().addInterceptor(redireciona).build()
    }

    private fun montarDispatcher(base: String): Dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.path.orEmpty().substringBefore('?')
            val corpo = request.body.readUtf8()
            val dataParam = request.requestUrl?.queryParameter("data")
            return when {
                path == "/player/source" && corpo.contains("video_id=fire-1") ->
                    MockResponse().setResponseCode(200).setBody(
                        """{"data":{"video_url":"$base/video/aaaaaaaaaaaaaaaa"}}""",
                    )
                path == "/player/source" && corpo.contains("video_id=fire-2") ->
                    MockResponse().setResponseCode(200).setBody(
                        """{"data":{"video_url":"$base/video/bbbbbbbbbbbbbbbb"}}""",
                    )
                path == "/video/aaaaaaaaaaaaaaaa" ->
                    MockResponse().setResponseCode(200)
                        .setHeader("Content-Type", "text/html")
                        .setBody("<html><body>fixture fire player</body></html>")
                path == "/video/bbbbbbbbbbbbbbbb" ->
                    MockResponse().setResponseCode(200)
                        .setHeader("Content-Type", "text/html")
                        .setBody("<html><body>fixture alternativo</body></html>")
                // A API legada nunca existiu para esta variante — é exatamente
                // o que o HAR real mostrou.
                path == "/player/index.php" && dataParam == "aaaaaaaaaaaaaaaa" ->
                    MockResponse().setResponseCode(403).setBody("sessão ausente")
                path == "/player/index.php" && dataParam == "bbbbbbbbbbbbbbbb" ->
                    MockResponse().setResponseCode(200)
                        .setHeader("Content-Type", "application/json")
                        .setBody("""{"securedLink":"$base/media/final.mp4"}""")
                path == "/media/final.mp4" ->
                    MockResponse().setResponseCode(200).setHeader("Content-Type", "video/mp4")
                else -> MockResponse().setResponseCode(404)
            }
        }
    }

    @Test
    fun `403 do POST legado do embedplayer nao aborta o failover`() = runBlocking {
        // IP literal, não server.url(): esta última monta a URL fazendo reverse
        // DNS de 127.0.0.1, e o resultado depende de configuração de rede da
        // máquina — em uma delas resolveu para um hostname arbitrário e a
        // conexão saiu tentando alcançar a internet de verdade.
        val base = "http://127.0.0.1:${server.port}"
        server.dispatcher = montarDispatcher(base)

        val warezUrl = "$base/serie/exemplo"
        val session = SuperflixExtractor.Session(
            "https://superflixapi.beer/serie/exemplo/1/1",
            clienteApontandoParaMock(),
            SuperflixExtractor.CookieStore(),
            SuperflixExtractor.Page(warezUrl, "<html></html>"),
            "page-token-fixture",
            "",
            listOf(
                SuperflixExtractor.SourceOption("fire-1", "Fire Player", isFile = false, orderScore = 0),
                SuperflixExtractor.SourceOption("fire-2", "Alternativo", isFile = false, orderScore = 0),
            ),
            null,
            "UA-fixture-teste",
        )

        // As duas opções continuam expostas de saída — nada foi colapsado em
        // uma única fonte antes de qualquer tentativa de resolução.
        assertEquals(2, session.options.size)

        // Sem WebView na JVM, o ramo do player externo falha de saída. O que se
        // verifica aqui não é ele conseguir, e sim ele NÃO abortar o failover:
        // cada candidata precisa ser tentada por conta própria.
        runCatching { session.resolveWithFailover() }

        val chamadas = generateSequence { server.takeRequest(0, java.util.concurrent.TimeUnit.MILLISECONDS) }
            .map { it.path.orEmpty().substringBefore('?') }
            .toList()
        assertEquals(
            "opção 1 precisa ser tentada e rejeitada antes da opção 2 — sem isso não é regressão do failover",
            2,
            chamadas.count { it == "/player/source" },
        )
        // O POST legado não existe nesta variante, e insistir nele era o que
        // fazia a fonte morrer de 403 em vez de entregar a mídia que a própria
        // página busca. Ver SuperflixEmbedMediaObserver.
        assertTrue(
            "o ramo do player externo não pode voltar a chamar o index.php legado",
            chamadas.none { it == "/player/index.php" },
        )
    }

    @Test
    fun `sem observador nenhum, opcoes do bootstrap continuam intactas mesmo com a primeira falhando`() = runBlocking {
        // Mesmo cenário, mas confirma o outro lado: resolveWithFailover() NÃO
        // resolve cedo demais — session.options nunca perde uma opção, mesmo
        // depois de uma tentativa rejeitada.
        val base = "http://127.0.0.1:${server.port}"
        server.dispatcher = montarDispatcher(base)
        val session = SuperflixExtractor.Session(
            "https://superflixapi.beer/serie/exemplo/1/1",
            clienteApontandoParaMock(),
            SuperflixExtractor.CookieStore(),
            SuperflixExtractor.Page("$base/serie/exemplo", "<html></html>"),
            "page-token-fixture",
            "",
            listOf(
                SuperflixExtractor.SourceOption("fire-1", "Fire Player", isFile = false, orderScore = 0),
                SuperflixExtractor.SourceOption("fire-2", "Alternativo", isFile = false, orderScore = 0),
            ),
            null,
            "UA-fixture-teste",
        )

        runCatching { session.resolveWithFailover() }

        assertEquals(2, session.options.size)
        assertEquals("Fire Player", session.options[0].label)
        assertEquals("Alternativo", session.options[1].label)
    }
}
