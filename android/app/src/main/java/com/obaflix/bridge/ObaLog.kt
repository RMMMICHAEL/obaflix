package com.obaflix.bridge

import android.os.Build
import android.util.Log
import java.util.ArrayDeque
import java.util.Locale

private const val TAG = "Obaflix"

/**
 * Log estruturado do caminho de reproducao.
 *
 * Motivo de existir: as mensagens espalhadas pelo app diziam O QUE aconteceu, mas
 * nao em qual tentativa, nem quanto tempo depois, nem em qual fase do funil. Com
 * varias fontes tentadas em sequencia (o player pula para a proxima quando uma
 * falha), o logcat virava uma lista de linhas soltas onde duas extracoes
 * concorrentes se misturavam e nao dava para dizer qual delas produziu o erro.
 *
 * Aqui cada tentativa ganha uma trilha ("t=ab12"), e cada linha carrega o tempo
 * desde o inicio dela e a fase do pipeline. O formato e fixo e pesquisavel:
 *
 *   [oba] t=ab12 +1832ms fase=cdn ev=resposta status=206 host=cdn.exemplo ct=video/mp4
 *
 * As ultimas linhas ficam num buffer em memoria: quando algo falha de verdade,
 * dumpTrilha reimprime a historia daquela tentativa em bloco, em vez de obrigar
 * a cacar linhas anteriores no meio do logcat do sistema.
 *
 * Nada aqui sai do aparelho — e so Log.d/Log.w/Log.e, lido via adb logcat.
 */
object ObaLog {

    /** Fases do funil, na ordem em que uma reproducao normal passa por elas. */
    object Fase {
        const val SESSAO = "sessao"
        const val BRIDGE = "bridge"
        const val EXTRACAO = "extracao"
        const val PROVEDOR = "provedor"
        const val MANIFESTO = "manifesto"
        const val CDN = "cdn"
        const val DOCUMENTO = "documento"
        const val PLAYER = "player"
        const val RENDER = "render"
    }

    private const val LIMITE_TRILHA = 240

    private val trilha = ArrayDeque<String>(LIMITE_TRILHA)

    @Volatile
    private var traceId: String = "----"

    @Volatile
    private var inicio: Long = System.currentTimeMillis()

    /** Evita que dois dumps do mesmo problema (JS + nativo) dupliquem a saida. */
    @Volatile
    private var ultimoDump: Long = 0L

    /**
     * Abre uma trilha nova. Chamada quando comeca uma tentativa de reproducao —
     * o id resultante aparece em toda linha dela.
     */
    fun novaTrilha(motivo: String, vararg campos: Pair<String, Any?>): String {
        val id = java.lang.Long.toHexString(System.nanoTime()).takeLast(4)
        synchronized(trilha) {
            trilha.clear()
            traceId = id
            inicio = System.currentTimeMillis()
        }
        evento(Fase.SESSAO, "inicio", *(arrayOf<Pair<String, Any?>>("motivo" to motivo) + campos))
        return id
    }

    /** Uma linha de progresso. campos vira "chave=valor" na ordem informada. */
    fun evento(fase: String, evento: String, vararg campos: Pair<String, Any?>) {
        val linha = montar(fase, evento, campos)
        registrar(linha)
        Log.d(TAG, linha)
    }

    /** Igual a evento, mas em nivel WARN: algo degradou sem interromper. */
    fun alerta(fase: String, evento: String, vararg campos: Pair<String, Any?>) {
        val linha = montar(fase, evento, campos)
        registrar(linha)
        Log.w(TAG, linha)
    }

    /**
     * Falha que interrompe esta fase. Alem da linha, imprime a trilha inteira —
     * e o momento em que saber o que veio antes deixa de ser opcional.
     */
    fun falha(
        fase: String,
        evento: String,
        erro: Throwable? = null,
        vararg campos: Pair<String, Any?>,
    ) {
        val extras = if (erro == null) {
            campos
        } else {
            // campos chega como Array<out Pair<...>>; a projecao nao aceita `plus`.
            (campos.toList() + listOf<Pair<String, Any?>>(
                "excecao" to erro.javaClass.simpleName,
                "causa" to erro.message?.take(160),
            )).toTypedArray()
        }
        val linha = montar(fase, evento, extras)
        registrar(linha)
        Log.e(TAG, linha)
        dumpTrilha(evento)
    }

    /**
     * Reimprime as linhas guardadas desta trilha, em bloco.
     *
     * Com limite de uma vez a cada 2s: uma falha real dispara varios caminhos de
     * erro quase juntos (o nativo desiste, o hls.js reclama, o <video> emite
     * error) e sem isso a mesma historia sairia tres vezes seguidas.
     */
    fun dumpTrilha(motivo: String) {
        val agora = System.currentTimeMillis()
        val copia = synchronized(trilha) {
            if (agora - ultimoDump < 2_000) return
            ultimoDump = agora
            trilha.toList()
        }
        if (copia.isEmpty()) return
        Log.e(TAG, "[oba] t=$traceId ---- trilha (motivo=$motivo, ${copia.size} passos) ----")
        copia.forEach { Log.e(TAG, "[oba-trilha] $it") }
        Log.e(TAG, "[oba] t=$traceId ---- fim da trilha ----")
    }

    /** Ambiente do aparelho: primeira coisa util quando "so falha nesse celular". */
    fun ambiente(extras: Map<String, Any?> = emptyMap()) {
        val campos = mutableListOf<Pair<String, Any?>>(
            "android" to Build.VERSION.RELEASE,
            "api" to Build.VERSION.SDK_INT,
            "aparelho" to "${Build.MANUFACTURER}/${Build.MODEL}",
            "abi" to (Build.SUPPORTED_ABIS.firstOrNull() ?: "?"),
        )
        extras.forEach { (chave, valor) -> campos.add(chave to valor) }
        evento(Fase.SESSAO, "ambiente", *campos.toTypedArray())
    }

    // -- Formatacao -----------------------------------------------------------

    private fun montar(fase: String, evento: String, campos: Array<out Pair<String, Any?>>): String {
        val decorrido = System.currentTimeMillis() - inicio
        val sb = StringBuilder(96)
        sb.append("[oba] t=").append(traceId)
            .append(" +").append(decorrido).append("ms")
            .append(" fase=").append(fase)
            .append(" ev=").append(evento)
        for ((chave, valor) in campos) {
            if (valor == null) continue
            val texto = valor.toString().trim()
            if (texto.isEmpty()) continue
            sb.append(' ').append(chave).append('=').append(escapar(texto))
        }
        return sb.toString()
    }

    /** Valor com espaco quebraria o parser "chave=valor" do script de terminal. */
    private fun escapar(valor: String): String {
        val curto = valor.take(300).replace('\n', ' ')
        return if (curto.contains(' ')) "\"" + curto.replace('"', '\'') + "\"" else curto
    }

    private fun registrar(linha: String) {
        synchronized(trilha) {
            if (trilha.size >= LIMITE_TRILHA) trilha.removeFirst()
            trilha.addLast(linha)
        }
    }

    // -- Higienizacao ---------------------------------------------------------

    private val TOKEN_LONGO = Regex("[A-Za-z0-9_-]{32,}")

    /**
     * URL sem segredo: mantem host e caminho, troca a query pela contagem de
     * parametros e mascara tokens longos que aparecam no proprio caminho.
     *
     * A query e onde vivem verify=, cfv= e as assinaturas do CDN. Elas nao
     * ajudam a diagnosticar nada e transformam qualquer log em algo que nao se
     * pode colar num chat.
     */
    fun url(raw: String?): String {
        if (raw.isNullOrBlank()) return "-"
        return runCatching {
            val u = java.net.URL(raw)
            val caminho = TOKEN_LONGO.replace(u.path) { "<${it.value.length}ch>" }
            val query = u.query
            val sufixo = if (query.isNullOrEmpty()) "" else "?<${query.split("&").size}p>"
            "${u.host}$caminho$sufixo"
        }.getOrElse { "url-invalida" }
    }

    private val URL_EM_TEXTO = Regex("""https?://[^\s"'<>)\]]+""")

    /**
     * Texto arbitrario — mensagem de console de pagina de terceiro, causa de
     * excecao — sem segredo.
     *
     * O console do provedor imprime as proprias URLs assinadas, e ate aqui elas
     * eram repassadas cruas ao logcat. Cada URL encontrada passa por [url], que
     * troca a query pela contagem de parametros; o que sobrar de token longo
     * solto no texto vira <Nch>.
     */
    fun texto(raw: String?): String {
        if (raw.isNullOrBlank()) return "-"
        val semUrl = URL_EM_TEXTO.replace(raw) { url(it.value) }
        return TOKEN_LONGO.replace(semUrl) { "<${it.value.length}ch>" }
    }

    /** So o host, para quando o caminho tambem nao interessa. */
    fun host(raw: String?): String = runCatching {
        java.net.URL(raw ?: return@runCatching "-").host.lowercase(Locale.ROOT)
    }.getOrDefault("-")

    /** Nome do arquivo pedido — o sinal mais direto da fase do HLS. */
    fun arquivo(raw: String?): String = runCatching {
        val caminho = java.net.URL(raw ?: return@runCatching "-").path
        caminho.substringAfterLast('/').ifEmpty { "/" }
    }.getOrDefault("-")
}
