package com.obaflix

import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.util.concurrent.TimeUnit

/**
 * Crash de "Continuar assistindo" (1.0.17), capturado no logcat:
 *
 * ```text
 * FATAL EXCEPTION: pool-5-thread-2
 * java.net.SocketException: Broken pipe
 *   at com.obaflix.LocalMediaServer.handle
 * ```
 *
 * O player abandonou a fonte nativa no failover, o WebView fechou a conexao com
 * o proxy local e a escrita seguinte derrubou o processo. Aqui a mesma falha de
 * E/S e provocada sem aparelho: nenhuma excecao pode sair de `atender`.
 */
class LocalMediaServerTest {

    /** Socket falso cuja escrita falha como um cliente que ja desconectou. */
    private class SocketQueQuebraNaEscrita(private val pedido: String) : Socket() {
        var fechado = false
        override fun getInputStream(): InputStream = pedido.byteInputStream()
        override fun getOutputStream(): OutputStream = object : OutputStream() {
            override fun write(b: Int) = throw java.net.SocketException("Broken pipe")
        }
        override fun close() { fechado = true }
    }

    private val clienteSemRede = OkHttpClient.Builder()
        .connectTimeout(1, TimeUnit.SECONDS)
        .readTimeout(1, TimeUnit.SECONDS)
        .build()

    @Test
    fun `cliente que desconecta no meio da resposta nao derruba o app`() {
        LocalMediaServer(clienteSemRede).use { server ->
            // Metodo invalido: o servidor tenta responder 405 e a escrita quebra.
            val socket = SocketQueQuebraNaEscrita("POST /s/x HTTP/1.1\r\n\r\n")
            val erro = runCatching { server.atender(socket) }.exceptionOrNull()
            assertNull("nenhuma excecao escapa para a thread do pool", erro)
            assertTrue("a conexao e fechada", socket.fechado)
        }
    }

    @Test
    fun `upstream inacessivel nao derruba o app`() {
        LocalMediaServer(clienteSemRede).use { server ->
            // Porta 1 em loopback recusa a conexao: OkHttp lanca IOException.
            val (id, endpoint) = server.start("https://127.0.0.1:1/master.m3u8", null, null)
            val caminho = endpoint.substringAfter("127.0.0.1").substringAfter("/").let { "/$it" }
            val socket = SocketQueQuebraNaEscrita("GET $caminho HTTP/1.1\r\n\r\n")
            val erro = runCatching { server.atender(socket) }.exceptionOrNull()
            assertNull(erro)
            assertTrue(socket.fechado)
            server.stop(id)
        }
    }

    @Test
    fun `o servidor continua atendendo depois de uma conexao quebrada`() {
        LocalMediaServer(clienteSemRede).use { server ->
            server.atender(SocketQueQuebraNaEscrita("POST / HTTP/1.1\r\n\r\n"))

            val (_, endpoint) = server.start("https://127.0.0.1:1/master.m3u8", null, null)
            val porta = endpoint.substringAfter("127.0.0.1:").substringBefore("/").toInt()
            // Sessao inexistente: resposta 404 real pelo socket de verdade.
            Socket("127.0.0.1", porta).use { s ->
                s.soTimeout = 5_000
                s.getOutputStream().write("GET /s/nao-existe?u=eA HTTP/1.1\r\n\r\n".toByteArray())
                val linha = try {
                    s.getInputStream().bufferedReader().readLine()
                } catch (e: IOException) {
                    null
                }
                assertEquals("HTTP/1.1 404 Error", linha)
            }
        }
    }
}
