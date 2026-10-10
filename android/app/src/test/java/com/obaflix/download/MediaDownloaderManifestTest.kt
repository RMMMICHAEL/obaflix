package com.obaflix.download

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.ServerSocket
import java.util.zip.GZIPOutputStream
import kotlin.concurrent.thread

class MediaDownloaderManifestTest {
    private val media = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg.ts\n#EXT-X-ENDLIST\n"
    private val master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nmedia.m3u8\n"
    private val request = MediaDownloader.pedido(
        DownloadSource("https://cdn.example/manifest", "https://embed.example/", "UA-teste", MediaKind.HLS, null),
        "https://cdn.example/manifest",
    )

    private class TrackedBody(bytes: ByteArray, private val declared: Long, onRead: () -> Unit = {}) : ResponseBody() {
        var closed = false
        var delivered = 0L
        private val input = object : ForwardingSource(Buffer().write(bytes)) {
            override fun read(sink: Buffer, byteCount: Long): Long {
                val n = super.read(sink, byteCount)
                if (n > 0) delivered += n
                onRead()
                return n
            }
            override fun close() { closed = true; super.close() }
        }.buffer()
        override fun contentType() = "text/plain".toMediaType()
        override fun contentLength() = declared
        override fun source(): BufferedSource = input
    }

    private class Fixture(val body: TrackedBody, status: Int = 200) {
        var requests = 0
        lateinit var call: Call
        lateinit var observed: Request
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            requests++
            call = chain.call()
            observed = chain.request()
            Response.Builder().request(observed).protocol(Protocol.HTTP_1_1)
                .code(status).message("test").body(body).build()
        }.build()
    }

    private fun padded(size: Int): ByteArray = ("#EXTM3U\n#" + "x".repeat(size - 9)).toByteArray()
    private fun rejected(f: Fixture) = runBlocking {
        try {
            MediaDownloader.lerManifesto(f.client, request)
            fail("Corpo acima do teto foi aceito")
        } catch (e: DownloadException) {
            assertEquals(DownloadFailure.MANIFESTO_INVALIDO, e.motivo)
        }
        assertEquals(1, f.requests)
        assertTrue(f.call.isCanceled())
        assertTrue(f.body.closed)
        // O BufferedSource pode antecipar um único bloco fixo, nunca o corpo inteiro.
        assertTrue(f.body.delivered <= MediaDownloader.MAX_MANIFEST_BYTES + 8192)
    }

    @Test fun `media pequena funciona fecha resposta e preserva headers`() = runBlocking {
        val f = Fixture(TrackedBody(media.toByteArray(), media.length.toLong()))
        val text = MediaDownloader.lerManifesto(f.client, request)
        assertEquals(media, text)
        assertEquals(1, HlsPlaylist.parseMedia(text).segmentos.size)
        assertTrue(f.body.closed)
        assertFalse(f.call.isCanceled())
        assertEquals("https://embed.example/", f.observed.header("Referer"))
        assertEquals("UA-teste", f.observed.header("User-Agent"))
    }

    @Test fun `master valido funciona mesmo rotulado text plain`() = runBlocking {
        val f = Fixture(TrackedBody(master.toByteArray(), -1))
        val text = MediaDownloader.lerManifesto(f.client, request)
        assertEquals(master, text)
        assertEquals("media.m3u8", HlsPlaylist.parseMaster(text).single().uri)
        assertTrue(f.body.closed)
    }

    @Test fun `exatamente quatro MiB e aceito`() = runBlocking {
        val bytes = padded(MediaDownloader.MAX_MANIFEST_BYTES.toInt())
        val f = Fixture(TrackedBody(bytes, -1))
        assertEquals(bytes.size, MediaDownloader.lerManifesto(f.client, request).length)
        assertTrue(f.body.closed)
    }

    @Test fun `limite mais um aborta sem retry`() {
        rejected(Fixture(TrackedBody(padded(MediaDownloader.MAX_MANIFEST_BYTES.toInt() + 1), -1)))
    }

    @Test fun `content length menor nao permite ultrapassar teto`() {
        rejected(Fixture(TrackedBody(padded(MediaDownloader.MAX_MANIFEST_BYTES.toInt() + 100_000), 10)))
    }

    @Test fun `content length grande nao rejeita corpo pequeno`() = runBlocking {
        val f = Fixture(TrackedBody(media.toByteArray(), Long.MAX_VALUE))
        assertEquals(media, MediaDownloader.lerManifesto(f.client, request))
    }

    @Test fun `BOM UTF8 e UTF16 continuam funcionando`() = runBlocking {
        for (bytes in listOf(byteArrayOf(0xef.toByte(), 0xbb.toByte(), 0xbf.toByte()) + media.toByteArray(),
            byteArrayOf(0xff.toByte(), 0xfe.toByte()) + media.toByteArray(Charsets.UTF_16LE))) {
            val f = Fixture(TrackedBody(bytes, -1))
            assertEquals(media, MediaDownloader.lerManifesto(f.client, request))
        }
    }

    @Test fun `cancelamento durante leitura cancela call e fecha corpo`() = runBlocking {
        val job = Job()
        val f = Fixture(TrackedBody(padded(50_000), -1) { job.cancel() })
        try {
            withContext(job) { MediaDownloader.lerManifesto(f.client, request) }
            fail("Cancelamento ignorado")
        } catch (_: CancellationException) { }
        assertTrue(f.body.closed)
        assertTrue(f.call.isCanceled())
        assertEquals(1, f.requests)
    }

    @Test fun `401 e 403 continuam fonte expirada sem retry`() = runBlocking {
        for (status in listOf(401, 403)) {
            val f = Fixture(TrackedBody(ByteArray(0), 0), status)
            try {
                MediaDownloader.lerManifesto(f.client, request)
                fail("HTTP de erro aceito")
            } catch (e: DownloadException) { assertEquals(DownloadFailure.FONTE_EXPIRADA, e.motivo) }
            assertTrue(f.body.closed)
            assertEquals(1, f.requests)
        }
    }

    @Test fun `falha de IO mantem tres tentativas`() = runBlocking {
        var attempts = 0
        val client = OkHttpClient.Builder().addInterceptor { attempts++; throw IOException("test") }.build()
        try {
            MediaDownloader.lerManifesto(client, request)
            fail("Falha de rede aceita")
        } catch (e: DownloadException) { assertEquals(DownloadFailure.REDE, e.motivo) }
        assertEquals(3, attempts)
    }

    // MockWebServer pertence apenas aos testes de :core-extractor. Servidor mínimo
    // mantém o escopo sem mudar build.gradle ou adicionar dependência ao :app.
    private fun networkBody(bytes: ByteArray, gzip: Boolean, chunked: Boolean, expected: String? = null) = runBlocking {
        val wire = if (gzip) ByteArrayOutputStream().also { out ->
            GZIPOutputStream(out).use { it.write(bytes) }
        }.toByteArray() else bytes
        ServerSocket(0).use { server ->
            val worker = thread(isDaemon = true) {
                try {
                    server.accept().use { socket ->
                        val reader = socket.getInputStream().bufferedReader()
                        while (!reader.readLine().isNullOrEmpty()) { }
                        val output = socket.getOutputStream()
                        val headers = "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/plain\r\n" +
                            (if (gzip) "Content-Encoding: gzip\r\n" else "") +
                            (if (chunked) "Transfer-Encoding: chunked\r\n" else "Content-Length: ${wire.size}\r\n") + "\r\n"
                        output.write(headers.toByteArray())
                        if (chunked) output.write("${wire.size.toString(16)}\r\n".toByteArray())
                        output.write(wire)
                        if (chunked) output.write("\r\n0\r\n\r\n".toByteArray())
                        output.flush()
                    }
                } catch (_: IOException) { /* Cliente cancela ao atingir o teto. */ }
            }
            val client = OkHttpClient()
            try {
                val text = MediaDownloader.lerManifesto(client, Request.Builder().url("http://127.0.0.1:${server.localPort}/").build())
                if (expected == null) fail("Resposta de rede acima do teto aceita")
                else assertEquals(expected, text)
            } catch (e: DownloadException) {
                if (expected != null) throw e
                assertEquals(DownloadFailure.MANIFESTO_INVALIDO, e.motivo)
            }
            finally { client.connectionPool.evictAll(); worker.join(2000) }
        }
    }

    @Test fun `chunked sem content length acima do teto e rejeitado`() {
        networkBody(padded(MediaDownloader.MAX_MANIFEST_BYTES.toInt() + 1), gzip = false, chunked = true)
    }

    @Test fun `gzip pequeno no transporte expandindo acima do teto e rejeitado`() {
        networkBody(padded(MediaDownloader.MAX_MANIFEST_BYTES.toInt() + 1), gzip = true, chunked = false)
    }

    @Test fun `gzip e chunked legitimos continuam funcionando`() {
        networkBody(media.toByteArray(), gzip = true, chunked = true, expected = media)
    }
}
