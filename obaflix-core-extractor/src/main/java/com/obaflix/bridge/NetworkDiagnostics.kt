package com.obaflix.bridge

import android.os.Build
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

/**
 * Traduz falhas de rede para uma mensagem que diz a FASE e a CAUSA.
 *
 * O motivo de existir: "Handshake failed" e a mensagem crua que o Conscrypt
 * devolve para qualquer erro de TLS. Ela chegava ate o log e ate a interface
 * sem dizer se o problema foi DNS, TCP, versao de TLS ou certificado — o que
 * tornava impossivel distinguir um provedor fora do ar de um host que o
 * Android daquele aparelho simplesmente nao consegue negociar.
 *
 * Nada aqui afrouxa validacao de certificado: o objetivo e explicar a falha,
 * nunca contorna-la.
 */
object NetworkDiagnostics {

    /** TLS 1.3 so passou a existir no Android 10 (API 29). */
    private val suportaTls13 = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    /** Host sem credenciais nem query, seguro para log. */
    fun safeHost(url: String): String = runCatching {
        java.net.URL(url).host.lowercase()
    }.getOrDefault("host desconhecido")

    /**
     * @param url  alvo da requisicao, usado so para nomear o host na mensagem.
     */
    fun describe(error: Throwable, url: String): String {
        val host = safeHost(url)
        return when (error) {
            is UnknownHostException ->
                "DNS: nao foi possivel resolver $host"

            is ConnectException ->
                "TCP: conexao recusada por $host"

            is SocketTimeoutException ->
                "timeout aguardando resposta de $host"

            is SSLPeerUnverifiedException ->
                "TLS: certificado de $host nao pode ser verificado"

            is SSLHandshakeException -> {
                val bruto = error.message.orEmpty()
                when {
                    // Assinatura do servidor recusando a versao oferecida pelo cliente.
                    bruto.contains("protocol_version", ignoreCase = true) ||
                        bruto.contains("PROTOCOL_VERSION", ignoreCase = true) ->
                        "TLS: $host recusou a versao de TLS deste aparelho" + dicaTls13()

                    bruto.contains("certificate", ignoreCase = true) ||
                        bruto.contains("CERTIFICATE_VERIFY_FAILED", ignoreCase = true) ->
                        "TLS: certificado de $host rejeitado"

                    bruto.contains("internal_error", ignoreCase = true) ->
                        "TLS: $host respondeu internal_error no handshake " +
                            "(HTTPS do provedor fora do ar)"

                    // "Handshake failed" puro: o Conscrypt nao detalha. Em Android 9
                    // ou anterior a causa mais provavel e o host exigir TLS 1.3.
                    else ->
                        "TLS: handshake com $host falhou" + dicaTls13()
                }
            }

            is SSLException ->
                "TLS: conexao com $host interrompida (${error.message?.take(60) ?: "sem detalhe"})"

            is IOException ->
                "rede: falha ao falar com $host (${error.message?.take(60) ?: error.javaClass.simpleName})"

            else -> error.message?.takeIf { it.isNotBlank() && it != "null" }
                ?: error.javaClass.simpleName
        }
    }

    private fun dicaTls13(): String =
        if (suportaTls13) {
            ""
        } else {
            " — este Android (${Build.VERSION.RELEASE}) nao suporta TLS 1.3, " +
                "exigido por alguns provedores"
        }
}
