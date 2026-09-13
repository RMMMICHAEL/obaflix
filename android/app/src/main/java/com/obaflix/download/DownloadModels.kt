package com.obaflix.download

import org.json.JSONObject

/**
 * Estados de um download, na ordem em que um download bem-sucedido passa por eles.
 *
 * PREPARANDO existe separado de BAIXANDO porque HLS gasta um tempo mensuravel
 * antes do primeiro byte de midia: baixar o master, escolher a variante, baixar
 * a playlist da variante e contar os segmentos. Sem esse estado a interface
 * ficaria em "0%" por varios segundos parecendo travada.
 */
enum class DownloadState {
    FILA,
    PREPARANDO,
    BAIXANDO,
    CONCLUIDO,
    FALHOU,
    CANCELADO;

    val terminal: Boolean get() = this == CONCLUIDO || this == FALHOU || this == CANCELADO

    companion object {
        fun from(raw: String?): DownloadState =
            values().firstOrNull { it.name == raw } ?: FILA
    }
}

/** Por que um download parou. Generico de proposito: nunca carrega URL nem token. */
enum class DownloadFailure {
    SEM_PASTA,
    PASTA_INVALIDA,
    FONTE_INCOMPATIVEL,
    FONTE_EXPIRADA,
    REDE,
    HTTP,
    MANIFESTO_INVALIDO,
    ESCRITA,
    DESCONHECIDO;

    companion object {
        fun from(raw: String?): DownloadFailure? =
            values().firstOrNull { it.name == raw }
    }
}

/** MP4 (arquivo unico) ou HLS (manifesto + segmentos). */
enum class MediaKind {
    MP4,
    HLS;

    companion object {
        fun from(raw: String?): MediaKind =
            if (raw != null && raw.equals("mp4", ignoreCase = true)) MP4 else HLS
    }
}

/**
 * Um download, como fica gravado.
 *
 * ## Por que [url], [referer] e [userAgent] podem estar vazios
 *
 * Esses tres campos sao a autorizacao da fonte — a URL assinada do CDN carrega
 * token e assinatura na query. Eles so existem enquanto o download precisa
 * deles (FILA, PREPARANDO, BAIXANDO) e sao apagados no instante em que o
 * download vira terminal, por [semSegredos]. Um registro CONCLUIDO gravado no
 * disco nao contem nada que sirva para rebuscar a midia na origem.
 *
 * A consequencia aceita: um download terminal nao pode ser "retomado", so
 * refeito do zero com uma resolucao nova. E o comportamento correto de
 * qualquer forma, porque o token da fonte antiga ja teria expirado.
 */
data class DownloadRecord(
    val id: Int,
    /** Id publico e estavel do conteudo (ex.: "serie:12:t1:e3"). Nunca uma URL. */
    val pid: String,
    val titulo: String,
    val kind: MediaKind,
    val state: DownloadState = DownloadState.FILA,
    val url: String = "",
    val referer: String? = null,
    val userAgent: String? = null,
    val bytesBaixados: Long = 0L,
    /** -1 quando o servidor nao declara tamanho (HLS quase sempre). */
    val bytesTotal: Long = -1L,
    val segmentosBaixados: Int = 0,
    val segmentosTotal: Int = 0,
    /**
     * Qualidade que o usuario escolheu no modal.
     *
     * [qualidadeId] segue ate o downloader e e o que impede a variante de ser
     * reescolhida por largura de banda; [qualidadeLabel] e so para a tela.
     * Ambos sobrevivem ao estado terminal — nao sao autorizacao, sao a resposta
     * a "qual versao deste episodio esta gravada aqui?".
     */
    val qualidadeId: String? = null,
    val qualidadeLabel: String? = null,
    /** URI do arquivo/pasta de saida dentro da arvore SAF escolhida. */
    val saidaUri: String? = null,
    val falha: DownloadFailure? = null,
    val criadoEm: Long = System.currentTimeMillis(),
    val atualizadoEm: Long = System.currentTimeMillis(),
) {

    /**
     * Progresso 0..100, ou -1 quando nao ha como saber.
     *
     * MP4 usa bytes (o Content-Length chega no primeiro response). HLS usa
     * contagem de segmentos, que e o unico total conhecido de antemao — somar
     * o tamanho de cada segmento exigiria um HEAD por segmento, e um episodio
     * tem centenas deles.
     */
    val progresso: Int
        get() = when {
            state == DownloadState.CONCLUIDO -> 100
            kind == MediaKind.HLS && segmentosTotal > 0 ->
                (segmentosBaixados * 100L / segmentosTotal).toInt().coerceIn(0, 100)
            bytesTotal > 0L ->
                (bytesBaixados * 100L / bytesTotal).toInt().coerceIn(0, 100)
            else -> -1
        }

    /** O mesmo registro sem a autorizacao da fonte. Aplicado ao virar terminal. */
    fun semSegredos(): DownloadRecord =
        copy(url = "", referer = null, userAgent = null)

    fun paraJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("pid", pid)
        put("titulo", titulo)
        put("kind", kind.name)
        put("state", state.name)
        put("url", url)
        put("referer", referer ?: "")
        put("userAgent", userAgent ?: "")
        put("bytesBaixados", bytesBaixados)
        put("bytesTotal", bytesTotal)
        put("segmentosBaixados", segmentosBaixados)
        put("segmentosTotal", segmentosTotal)
        put("qualidadeId", qualidadeId ?: "")
        put("qualidadeLabel", qualidadeLabel ?: "")
        put("saidaUri", saidaUri ?: "")
        put("falha", falha?.name ?: "")
        put("criadoEm", criadoEm)
        put("atualizadoEm", atualizadoEm)
    }

    /**
     * O que o JavaScript recebe.
     *
     * Deliberadamente sem url/referer/userAgent: a interface mostra titulo,
     * estado e progresso, e nada na tela precisa da URL autorizada. Manter isso
     * fora do JSON impede que ela apareca no DOM, num state do React ou num
     * console.log da pagina.
     */
    fun paraJsonPublico(): JSONObject = JSONObject().apply {
        put("id", id)
        put("pid", pid)
        put("titulo", titulo)
        put("kind", kind.name.lowercase())
        put("state", state.name.lowercase())
        put("qualidade", qualidadeLabel ?: JSONObject.NULL)
        put("progresso", progresso)
        put("bytesBaixados", bytesBaixados)
        put("bytesTotal", bytesTotal)
        put("falha", falha?.name?.lowercase() ?: JSONObject.NULL)
        put("criadoEm", criadoEm)
    }

    companion object {
        fun deJson(json: JSONObject): DownloadRecord = DownloadRecord(
            id = json.optInt("id"),
            pid = json.optString("pid"),
            titulo = json.optString("titulo"),
            kind = MediaKind.from(json.optString("kind")),
            state = DownloadState.from(json.optString("state")),
            url = json.optString("url"),
            referer = json.optString("referer").ifBlank { null },
            userAgent = json.optString("userAgent").ifBlank { null },
            bytesBaixados = json.optLong("bytesBaixados"),
            bytesTotal = json.optLong("bytesTotal", -1L),
            segmentosBaixados = json.optInt("segmentosBaixados"),
            segmentosTotal = json.optInt("segmentosTotal"),
            qualidadeId = json.optString("qualidadeId").ifBlank { null },
            qualidadeLabel = json.optString("qualidadeLabel").ifBlank { null },
            saidaUri = json.optString("saidaUri").ifBlank { null },
            falha = DownloadFailure.from(json.optString("falha").ifBlank { null }),
            criadoEm = json.optLong("criadoEm"),
            atualizadoEm = json.optLong("atualizadoEm"),
        )
    }
}
