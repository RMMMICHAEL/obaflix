package com.obaflix.bridge

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.security.SecureRandom

/**
 * Origem local, real e estavel que hospeda o documento que **embute** o
 * provedor no overlay do desafio.
 *
 * Motivo de existir: ate aqui o overlay montava o documento com
 * `loadDataWithBaseURL(<url do app>, ...)`. O endereco base so serve para
 * resolver caminhos relativos — por baixo o documento continua sendo uma
 * navegacao `data:`, e um documento `data:` **nao e contexto seguro**. Contexto
 * seguro nao e herdado para baixo: um iframe https dentro de um topo nao
 * confiavel deixa de ser contexto seguro tambem. Dentro dele
 * `window.crypto.subtle` simplesmente nao existe, e o widget do desafio morre
 * na primeira chamada — foi exatamente o "TypeError: this[...] is not a
 * function" que apareceu no console logo depois do iframe carregar. Pelo mesmo
 * motivo o topo nao tem site proprio, e o cookie que o provedor grava dentro do
 * iframe nunca aparecia no `CookieManager`.
 *
 * O Electron nunca esbarrou nisso porque o wrapper dele e servido por HTTP de
 * verdade, em `http://127.0.0.1:<porta>/superflix-wrapper` — endereco de
 * loopback e origem confiavel por especificacao. Aqui o equivalente Android e o
 * `WebViewAssetLoader`: `https://appassets.androidplatform.net/...`, um dominio
 * reservado que nunca sai do aparelho, com esquema https e portanto contexto
 * seguro e site de topo estavel.
 *
 * Nada aqui resolve, fabrica ou copia desafio nenhum: o documento continua
 * sendo um iframe em tela cheia, e quem resolve o Turnstile e o usuario.
 */
object SuperflixWrapperHost {

    /** Dominio reservado do WebViewAssetLoader — nao resolve em DNS. */
    const val HOST = "appassets.androidplatform.net"

    private const val ORIGEM = "https://appassets.androidplatform.net"
    private const val PREFIXO = "/superflix/"
    private const val PAGINA = "wrapper.html"
    private const val SINAL = "sinal"

    private val aleatorio = SecureRandom()

    /**
     * Segmento aleatorio renovado a cada abertura.
     *
     * Sem ele, qualquer documento que a WebView viesse a carregar poderia pedir
     * o wrapper por um endereco fixo e conhecido. Com ele, o unico caminho
     * valido e o que acabamos de sortear para esta sessao.
     */
    @Volatile
    private var nonce: String = ""

    @Volatile
    private var embedUrl: String = ""

    private val loader: WebViewAssetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler(PREFIXO) { caminho -> responder(caminho) }
            .build()
    }

    /** Sorteia a sessao e devolve o endereco do wrapper a ser carregado. */
    fun preparar(embed: String): String {
        val bytes = ByteArray(16)
        aleatorio.nextBytes(bytes)
        nonce = bytes.joinToString("") { "%02x".format(it) }
        embedUrl = embed
        return ORIGEM + PREFIXO + nonce + "/" + PAGINA
    }

    /** Invalida o endereco: depois disto nenhum caminho e mais servido. */
    fun encerrar() {
        nonce = ""
        embedUrl = ""
    }

    /**
     * Interceptador para o `PlayerWebViewClient` do overlay.
     *
     * Devolve `null` para tudo que nao seja o nosso dominio local, entao o
     * fluxo normal do cliente segue intacto para o provedor e para o CDN.
     */
    fun interceptar(url: android.net.Uri): WebResourceResponse? {
        if (!HOST.equals(url.host, ignoreCase = true)) return null
        return loader.shouldInterceptRequest(url)
    }

    // ── Documento ──────────────────────────────────────────────────────────

    /**
     * Aspas de string JavaScript. O endereco vem do nosso backend, mas entra
     * num documento — escapar e o que garante que ele nao possa fechar a string
     * e virar codigo, nem fechar a tag `script`.
     */
    internal fun aspasJs(raw: String): String {
        val sb = StringBuilder("\"")
        raw.forEach { c ->
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '<' -> sb.append("\\u003c")
                c == '>' -> sb.append("\\u003e")
                c == '&' -> sb.append("\\u0026")
                c.code < 0x20 || c.code == 0x2028 || c.code == 0x2029 ->
                    sb.append("\\u%04x".format(c.code))
                else -> sb.append(c)
            }
        }
        return sb.append("\"").toString()
    }

    /**
     * Mesmo documento que o wrapper do Electron: iframe em tela cheia, fundo
     * preto, `no-referrer` e `src` atribuido por script — para o ouvinte de
     * `load` estar no lugar antes de a navegacao comecar.
     */
    internal fun documento(embed: String, nonceDaSessao: String): String {
        val src = aspasJs(embed)
        val base = aspasJs(PREFIXO + nonceDaSessao + "/" + SINAL + "/")
        return buildString {
            append("<!DOCTYPE html>\n")
            append("<html lang=\"pt-BR\"><head>\n")
            append("<meta charset=\"utf-8\">\n")
            append("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n")
            append("<meta name=\"referrer\" content=\"no-referrer\">\n")
            append("<style>html,body{margin:0;padding:0;width:100%;height:100%;")
            append("background:#000;overflow:hidden}\n")
            append("#f{position:fixed;top:0;left:0;width:100%;height:100%;")
            append("border:0;display:block;background:#000}</style>\n")
            append("</head><body>\n")
            append("<iframe id=\"f\" allow=\"autoplay; fullscreen; encrypted-media\"")
            append(" allowfullscreen webkitallowfullscreen></iframe>\n")
            append("<script>\n(function(){\n")
            append("  var base=").append(base).append(";\n")
            append("  function sinal(p){try{fetch(base+p,{cache:\"no-store\"});}catch(e){}}\n")
            append("  var seguro=window.isSecureContext?1:0;\n")
            append("  var subtle=(window.crypto&&window.crypto.subtle)?1:0;\n")
            append("  sinal(\"documento/\"+seguro+\"/\"+subtle);\n")
            append("  var f=document.getElementById(\"f\");\n")
            append("  f.addEventListener(\"load\",function(){sinal(\"iframe/1/1\");},{once:true});\n")
            append("  f.src=").append(src).append(";\n")
            append("})();\n</script>\n")
            append("</body></html>")
        }
    }

    // ── Respostas ──────────────────────────────────────────────────────────

    /** Caminho ja sem o prefixo `/superflix/`; devolve null quando nao confere. */
    internal fun rotaDe(caminhoBruto: String, nonceDaSessao: String): String? {
        if (nonceDaSessao.isEmpty()) return null
        val caminho = caminhoBruto.trimStart('/')
        if (!caminho.startsWith(nonceDaSessao + "/")) return null
        return caminho.removePrefix(nonceDaSessao + "/")
    }

    private fun responder(caminhoBruto: String): WebResourceResponse? {
        val n = nonce
        val rota = rotaDe(caminhoBruto, n)
        if (rota == null) {
            ObaLog.alerta(ObaLog.Fase.PROVEDOR, "wrapper_caminho_recusado")
            return null
        }
        if (rota == PAGINA) {
            val embed = embedUrl
            if (embed.isEmpty()) return null
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "wrapper_servido",
                "origem" to ORIGEM,
                "embed" to ObaLog.host(embed),
            )
            return html(documento(embed, n))
        }
        if (rota.startsWith(SINAL + "/")) {
            registrarSinal(rota.removePrefix(SINAL + "/"))
            return vazio()
        }
        return null
    }

    /**
     * Diagnostico vindo do nosso proprio documento — nunca do provedor.
     *
     * Os valores viajam no caminho porque o `PathHandler` do
     * `WebViewAssetLoader` so recebe o caminho, sem query. Sao dois bits:
     * contexto seguro e presenca de `crypto.subtle`. E o que separa "o desafio
     * foi recusado" de "o desafio nunca teve como rodar aqui".
     */
    private fun registrarSinal(resto: String) {
        val partes = resto.trim('/').split("/")
        when (partes.getOrNull(0)) {
            "documento" -> ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "wrapper_documento_pronto",
                "contexto_seguro" to (partes.getOrNull(1) == "1"),
                "crypto_subtle" to (partes.getOrNull(2) == "1"),
            )
            "iframe" -> ObaLog.evento(ObaLog.Fase.PROVEDOR, "wrapper_iframe_carregado")
            else -> Unit
        }
    }

    private fun cabecalhos(): Map<String, String> = mapOf(
        "Cache-Control" to "no-store, no-cache, must-revalidate",
        "Referrer-Policy" to "no-referrer",
        // O documento e nosso e minusculo: so o proprio inline, a conexao de
        // volta para esta origem e o frame do provedor. Tudo o mais recusado.
        "Content-Security-Policy" to (
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
                "connect-src 'self'; frame-src https:; img-src data:"
            ),
    )

    private fun html(corpo: String) = WebResourceResponse(
        "text/html", "utf-8", 200, "OK",
        cabecalhos(),
        ByteArrayInputStream(corpo.toByteArray(Charsets.UTF_8)),
    )

    private fun vazio() = WebResourceResponse(
        "text/plain", "utf-8", 200, "OK",
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(ByteArray(0)),
    )
}
