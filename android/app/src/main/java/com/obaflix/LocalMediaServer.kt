package com.obaflix

import com.obaflix.bridge.ObaLog
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Proxy de mídia limitado ao processo e ao loopback. Cada sessão é opaca e só
 * aceita URLs HTTPS; o WebView nunca ganha um proxy aberto para a internet.
 */
class LocalMediaServer(private val client: OkHttpClient = OkHttpClient()) : AutoCloseable {
    private data class Session(val stream: String, val referer: String?, val userAgent: String?)
    private val sessions = ConcurrentHashMap<String, Session>()
    private val pool = Executors.newCachedThreadPool()
    private val socket = ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"))

    init { pool.execute { acceptLoop() } }

    fun start(stream: String, referer: String?, userAgent: String?): Pair<String, String> {
        require(URL(stream).protocol.equals("https", true)) { "Mídia sem HTTPS" }
        val id = UUID.randomUUID().toString()
        sessions[id] = Session(stream, referer, userAgent)
        return id to endpoint(id, stream)
    }

    fun stop(id: String) { sessions.remove(id) }

    /** A midia real por tras de um endereco deste proxy, com os headers da sessao. */
    data class Origem(val url: String, val referer: String?, val userAgent: String?)

    /**
     * Desfaz um endereco de loopback deste servidor.
     *
     * Episodio Playerflix toca por `http://127.0.0.1:<porta>/s/<sessao>?u=...`, e
     * e esse endereco que o player conhece. Um app externo de transmissao nao
     * alcanca o loopback do aparelho — nem deveria: precisa da URL https de
     * origem e dos headers que a sessao ja guarda.
     *
     * So responde para a porta deste servidor e uma sessao ativa; a URL devolvida
     * e a que a propria sessao autorizou (https). Qualquer outra forma: `null`.
     */
    fun origemDe(url: String): Origem? {
        val uri = runCatching { java.net.URI(url) }.getOrNull() ?: return null
        if (uri.scheme != "http" || uri.host != "127.0.0.1" || uri.port != socket.localPort) return null
        val partes = uri.path.orEmpty().split('/')
        if (partes.size != 3 || partes[1] != "s") return null
        val session = sessions[partes[2]] ?: return null
        val encoded = uri.rawQuery?.takeIf { it.startsWith("u=") }?.substring(2) ?: return null
        val upstream = runCatching { String(Base64.getUrlDecoder().decode(encoded), Charsets.UTF_8) }.getOrNull()
            ?: return null
        if (!runCatching { URL(upstream).protocol.equals("https", true) }.getOrDefault(false)) return null
        return Origem(upstream, session.referer, session.userAgent)
    }

    private fun endpoint(id: String, url: String): String =
        "http://127.0.0.1:${socket.localPort}/s/$id?u=" +
            Base64.getUrlEncoder().withoutPadding().encodeToString(url.toByteArray(Charsets.UTF_8))

    private fun acceptLoop() {
        while (!socket.isClosed) runCatching { socket.accept() }.getOrNull()?.let { clientSocket ->
            pool.execute { atender(clientSocket) }
        }
    }

    /**
     * Uma conexao do WebView, sem deixar excecao escapar para a thread do pool.
     *
     * O player abandona requisicoes o tempo todo — troca de fonte, seek, retomada
     * de "Continuar assistindo" — e o WebView fecha o socket no meio da resposta.
     * A escrita seguinte lanca `SocketException: Broken pipe`; sem este cerco ela
     * virava excecao nao tratada na thread e derrubava o processo do app inteiro.
     * Upstream fora do ar (timeout, DNS) tem o mesmo efeito e o mesmo tratamento:
     * a conexao fecha, o player ve a falha da fonte e segue o failover.
     */
    internal fun atender(clientSocket: Socket) {
        try {
            clientSocket.use(::handle)
        } catch (e: Exception) {
            // Sem URL, sem query, sem sessao: so a classe da excecao.
            runCatching {
                ObaLog.alerta("media", "local_proxy_conexao_encerrada", "excecao" to e.javaClass.simpleName)
            }
        }
    }

    private fun handle(socket: Socket) {
        val input = BufferedInputStream(socket.getInputStream())
        val requestLine = input.readLineAscii() ?: return
        val parts = requestLine.split(' ')
        if (parts.size < 2 || parts[0] != "GET") return socket.writeError(405)
        val headers = linkedMapOf<String, String>()
        while (true) {
            val line = input.readLineAscii() ?: return
            if (line.isEmpty()) break
            val i = line.indexOf(':'); if (i > 0) headers[line.substring(0, i).lowercase()] = line.substring(i + 1).trim()
        }
        val uri = runCatching { java.net.URI("http://127.0.0.1" + parts[1]) }.getOrNull() ?: return socket.writeError(400)
        val id = uri.path.split('/').getOrNull(2) ?: return socket.writeError(404)
        val session = sessions[id] ?: return socket.writeError(404)
        val encoded = uri.rawQuery?.substringAfter("u=", "") ?: return socket.writeError(400)
        val upstream = runCatching { String(Base64.getUrlDecoder().decode(encoded), Charsets.UTF_8) }.getOrNull()
            ?: return socket.writeError(400)
        if (!runCatching { URL(upstream).protocol.equals("https", true) }.getOrDefault(false)) return socket.writeError(403)
        val request = Request.Builder().url(upstream).apply {
            session.referer?.let { header("Referer", it) }
            session.userAgent?.let { header("User-Agent", it) }
            headers["range"]?.let { header("Range", it) }
        }.build()
        client.newCall(request).execute().use { response ->
            val body = response.body ?: return socket.writeError(response.code)
            val type = response.header("Content-Type").orEmpty()
            val playlist = type.contains("mpegurl", true) || upstream.substringBefore('?').endsWith(".m3u8", true)
            val output = BufferedOutputStream(socket.getOutputStream())
            if (playlist) {
                val text = body.string()
                val rewritten = rewritePlaylist(text, upstream, id)
                output.write(("HTTP/1.1 ${response.code} OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: ${rewritten.toByteArray().size}\r\nAccess-Control-Allow-Origin: *\r\n\r\n").toByteArray())
                output.write(rewritten.toByteArray())
            } else {
                val length = body.contentLength()
                output.write(("HTTP/1.1 ${response.code} OK\r\nContent-Type: ${if (type.isBlank()) "application/octet-stream" else type}\r\n" +
                    (if (length >= 0) "Content-Length: $length\r\n" else "") + "Accept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\n\r\n").toByteArray())
                body.byteStream().copyTo(output)
            }
            output.flush()
        }
    }

    private fun rewritePlaylist(text: String, parent: String, id: String): String = text.lineSequence().joinToString("\n") { line ->
        if (line.isBlank() || line.startsWith("#")) line
        else endpoint(id, URL(URL(parent), line).toString())
    }

    private fun BufferedInputStream.readLineAscii(): String? {
        val bytes = ArrayList<Byte>(); while (true) { val b = read(); if (b < 0) return if (bytes.isEmpty()) null else bytes.toByteArray().toString(Charsets.ISO_8859_1); if (b == 10) return bytes.toByteArray().toString(Charsets.ISO_8859_1).trimEnd('\r'); bytes += b.toByte() }
    }
    private fun Socket.writeError(code: Int) { getOutputStream().use { it.write("HTTP/1.1 $code Error\r\nContent-Length: 0\r\n\r\n".toByteArray()) } }
    override fun close() { sessions.clear(); socket.close(); pool.shutdownNow() }
}
