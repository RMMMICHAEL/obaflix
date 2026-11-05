package com.obaflix.bridge.media

import kotlinx.coroutines.*
import java.io.Closeable
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** Only serves one opaque session. The byte supplier runs inside the owning WebView. */
internal class LocalMediaServer(
    private val token: String,
    private val total: Long,
    private val read: suspend (Long, Long) -> ByteArray,
) : Closeable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val closed = AtomicBoolean(false)
    private val clients = ConcurrentHashMap.newKeySet<Socket>()
    private val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
    val stream = "http://127.0.0.1:${server.localPort}/abyss-media/$token"

    init {
        require(total > 0)
        scope.launch {
            try {
                while (isActive) {
                    val socket = server.accept()
                    synchronized(clients) {
                        if (closed.get() || clients.size >= 4) socket.close()
                        else {
                            clients.add(socket)
                            launch { serve(socket) }
                        }
                    }
                }
            } catch (_: Exception) { close() }
        }
    }

    private suspend fun serve(socket: Socket) {
        try {
            socket.soTimeout = 15_000
            socket.tcpNoDelay = true
            val input = socket.getInputStream()
            val request = line(input).split(' ')
            val headers = mutableMapOf<String, String>()
            var headerBytes = 0
            while (true) {
                val header = line(input)
                headerBytes += header.length
                require(headerBytes <= 16_384)
                if (header.isEmpty()) break
                val split = header.indexOf(':')
                require(split > 0)
                val key = header.substring(0, split).lowercase()
                val value = header.substring(split + 1).trim()

                // Repeated HTTP headers are legal. Media3/OkHttp can emit them,
                // so rejecting every duplicate here can reset a perfectly valid
                // localhost connection before the response even starts.
                if (key == "range" && headers.containsKey(key)) {
                    error("Multiple Range headers")
                }
                headers.putIfAbsent(key, value)
            }
            val out = socket.getOutputStream()
            fun respond(status: String, length: Long, extra: String = "") {
                out.write(("HTTP/1.1 $status\r\nConnection: close\r\n" +
                    "Content-Length: $length\r\nContent-Type: video/mp4\r\n" +
                    "Accept-Ranges: bytes\r\nCache-Control: no-store\r\n" + extra + "\r\n").toByteArray(Charsets.US_ASCII))
                out.flush()
            }
            if (request.size != 3 || request[1] != "/abyss-media/$token") {
                respond("404 Not Found", 0); return
            }
            if (request[0] != "GET" && request[0] != "HEAD") {
                respond("405 Method Not Allowed", 0, "Allow: GET, HEAD\r\n"); return
            }
            val range = range(headers["range"], total)
            if (range == null) {
                respond("416 Range Not Satisfiable", 0, "Content-Range: bytes */$total\r\n"); return
            }
            val (start, end) = range
            val requestStarted = System.currentTimeMillis()
            android.util.Log.i(
                "LocalMediaServer",
                "REQUEST method=${request[0]} range=${headers["range"] ?: "-"} start=$start end=$end bytes=${end - start + 1}",
            )
            respond(if (headers.containsKey("range")) "206 Partial Content" else "200 OK", end - start + 1,
                if (headers.containsKey("range")) "Content-Range: bytes $start-$end/$total\r\n" else "")
            if (request[0] == "HEAD") return
            var offset = start
            while (offset <= end && !closed.get()) {
                currentCoroutineContext().ensureActive()

                // Mantem cada mensagem em 256 KB, mas busca uma pequena janela
                // em paralelo dentro do frame Abyss. As respostas continuam
                // sendo escritas no socket rigorosamente na ordem.
                val ranges = buildList {
                    var cursor = offset
                    repeat(PREFETCH_CHUNKS) {
                        if (cursor <= end) {
                            val last = minOf(end, cursor + CHUNK_SIZE - 1)
                            add(cursor to last)
                            cursor = last + 1
                        }
                    }
                }

                val fetched = coroutineScope {
                    ranges.map { (chunkStart, chunkEnd) ->
                        async {
                            val fetchStarted = System.currentTimeMillis()
                            val bytes = withTimeout(30_000) { read(chunkStart, chunkEnd) }
                            val fetchMs = System.currentTimeMillis() - fetchStarted
                            android.util.Log.i(
                                "LocalMediaServer",
                                "FETCH start=$chunkStart end=$chunkEnd bytes=${bytes.size} ms=$fetchMs",
                            )
                            check(bytes.size.toLong() == chunkEnd - chunkStart + 1) {
                                "Incomplete WebView range"
                            }
                            Triple(chunkStart, chunkEnd, bytes)
                        }
                    }.awaitAll()
                }

                for ((chunkStart, chunkEnd, bytes) in fetched) {
                    currentCoroutineContext().ensureActive()
                    if (closed.get()) break

                    val chunkStarted = System.currentTimeMillis()
                    out.write(bytes)
                    out.flush()
                    android.util.Log.i(
                        "LocalMediaServer",
                        "CHUNK start=$chunkStart end=$chunkEnd bytes=${bytes.size} ms=${System.currentTimeMillis() - chunkStarted}",
                    )
                    offset = chunkEnd + 1
                }
            }
            android.util.Log.i(
                "LocalMediaServer",
                "RESPONSE_DONE start=$start end=$end ms=${System.currentTimeMillis() - requestStarted}",
            )
        } catch (error: Exception) {
            // Disconnect/seek/stop can legitimately abort a response, but keep
            // the reason visible while this bridge is being validated.
            android.util.Log.w(
                "LocalMediaServer",
                "CLIENT_FAIL ${error.javaClass.simpleName}: ${error.message}",
                error,
            )
        } finally {
            clients.remove(socket)
            runCatching { socket.close() }
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { server.close() }
        synchronized(clients) {
            clients.forEach { runCatching { it.close() } }
            clients.clear()
        }
        scope.cancel()
    }

    companion object {
        const val CHUNK_SIZE = 256 * 1024
        const val PREFETCH_CHUNKS = 1

        /** A single HTTP byte range, including open-ended and suffix forms. */
        fun range(header: String?, total: Long): Pair<Long, Long>? {
            if (total <= 0) return null
            if (header == null) return 0L to total - 1
            val match = Regex("bytes=(\\d*)-(\\d*)", RegexOption.IGNORE_CASE).matchEntire(header) ?: return null
            val a = match.groupValues[1]
            val b = match.groupValues[2]
            if (a.isEmpty()) {
                val suffix = b.toLongOrNull()?.takeIf { it > 0 } ?: return null
                return maxOf(0L, total - suffix) to total - 1
            }
            val start = a.toLongOrNull()?.takeIf { it in 0 until total } ?: return null
            val end = if (b.isEmpty()) total - 1 else b.toLongOrNull() ?: return null
            if (end < start) return null
            return start to minOf(end, total - 1)
        }

        private fun line(input: InputStream): String {
            val text = StringBuilder()
            while (text.length < 4096) {
                val byte = input.read()
                require(byte >= 0) { "Incomplete HTTP request" }
                if (byte == 10) return text.toString().removeSuffix("\r")
                text.append(byte.toChar())
            }
            error("HTTP line too long")
        }
    }
}
