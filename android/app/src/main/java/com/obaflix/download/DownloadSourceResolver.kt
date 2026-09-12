package com.obaflix.download

import org.json.JSONObject
import java.net.URL

/**
 * Uma fonte que pode ser baixada com a autorizacao que ja temos.
 *
 * So e construida por [DownloadSourceResolver]. Os tres campos de autorizacao
 * ([url], [referer], [userAgent]) sao exatamente os mesmos que o
 * PlayerWebViewClient injeta quando a WebView busca a midia — nada e
 * fabricado, nada e derivado de cookie.
 */
data class DownloadSource(
    val url: String,
    val referer: String?,
    val userAgent: String?,
    val kind: MediaKind,
    val expiresAt: Long?,
)

/** Por que uma fonte nao serve para download. Vira mensagem generica na tela. */
enum class MotivoInelegivel {
    /**
     * A midia so existe dentro da sessao do navegador que a autorizou.
     *
     * E o caso do manifesto em memoria do Superflix/Fire Player: o Chromium
     * consumiu a resposta com 2xx, mas a MESMA URL responde 403 para qualquer
     * outra requisicao, inclusive no mesmo instante. Nao ha nada a "reproduzir"
     * aqui sem copiar a sessao — que e exatamente o que nao se faz.
     */
    SESSAO_DO_NAVEGADOR,

    /** Sem stream na resposta, ou a resolucao falhou antes. */
    SEM_STREAM,

    /** Only HTTPS. Mesma regra do StreamExtractor. */
    NAO_HTTPS,

    /** O token da fonte ja venceu; baixar comecaria com 403. */
    EXPIRADA,

    /** URL malformada. */
    URL_INVALIDA,

    /**
     * HLS nao vira arquivo unico nesta versao.
     *
     * Baixar HLS gravava dezenas de segmentos .ts e um index.m3u8 na pasta da
     * pessoa — nao e um video que ela consiga abrir. Juntar os segmentos num
     * arquivo unico exige remux confiavel, que fica para depois. So o download
     * recusa: a transmissao continua aceitando HLS (ver [DownloadSourceResolver.paraDownload]).
     */
    HLS_SEM_ARQUIVO_UNICO,
}

sealed class DownloadElegibilidade {
    data class Elegivel(val source: DownloadSource) : DownloadElegibilidade()
    data class Inelegivel(val motivo: MotivoInelegivel) : DownloadElegibilidade()
}

/**
 * Converte uma resolucao **ja autorizada** numa fonte apta a download.
 *
 * ## O que esta camada deliberadamente NAO faz
 *
 * Nao resolve nada. Nao chama extractor, nao abre WebView, nao pede
 * `/player/source`, nao renova token, nao reproduz desafio da Cloudflare e nao
 * le cookie. Ela recebe o objeto que `window.obaflixDesktop.extractStream` /
 * `resolveSuperflix` **ja devolveram** para a reproducao normal e apenas
 * decide se aquilo da para baixar.
 *
 * Duas razoes para ser assim:
 *
 *  1. **Custo zero.** A resolucao ja foi paga pelo caminho de reproducao. Um
 *     segundo sistema de resolucao dobraria as requisicoes ao provedor, a
 *     Vercel e ao Supabase, e divergiria em silencio do primeiro na proxima
 *     vez que o provedor mudasse.
 *  2. **Nao mexe no estado do player.** `StreamExtractor.extract` grava em
 *     `ObaflixApp.playerState` (host de CDN liberado, Referer, User-Agent) —
 *     e disso depende a injecao de headers da reproducao em curso. Resolver de
 *     novo por fora, com um video tocando, sobrescreveria esse estado e
 *     quebraria o video que esta na tela.
 *
 * A escolha de uma fonte alternativa, quando esta e inelegivel, tambem nao
 * acontece aqui: quem tem a lista de fontes e a sessao autenticada e o lado
 * web. Esta camada devolve [DownloadElegibilidade.Inelegivel] e o lado web
 * oferece a proxima candidata — a politica fica no Kotlin, a lista fica onde
 * ela ja vivia.
 */
object DownloadSourceResolver {

    /**
     * Margem antes do vencimento declarado.
     *
     * Uma fonte que vence em 30 segundos tecnicamente ainda responde, mas um
     * episodio leva minutos para baixar e o 403 chegaria no meio, deixando um
     * arquivo pela metade. Recusar na entrada da um erro honesto em vez de um
     * arquivo corrompido.
     */
    const val MARGEM_EXPIRACAO_MS = 60_000L

    /**
     * @param payload o JSON que a ponte devolveu para a reproducao.
     * @param agora injetavel para teste.
     */
    /**
     * Caminhos de resolucao cuja midia fica presa a sessao que a autorizou.
     *
     * O Superflix/Fire Player resolve dentro de um contexto de navegador com
     * desafio da Cloudflare, cookie `cf_clearance` e token de pagina. O que sai
     * dali vale para aquela sessao e mais nada — inclusive o manifesto, que em
     * parte dos casos so existe em memoria.
     */
    private val ORIGENS_DE_SESSAO = setOf("superflix")

    fun classificar(payload: JSONObject, agora: Long = System.currentTimeMillis()): DownloadElegibilidade {
        // 1. Duas barreiras para a mesma coisa: "esta midia esta presa a sessao
        //    do navegador?".
        //
        //    (a) `manifest` preenchido e a prova nativa — o Chromium consumiu a
        //        resposta protegida e a MESMA URL responde 403 para qualquer
        //        outro cliente. Hoje a ponte de reproducao nao repassa esse
        //        campo ao JavaScript, entao ele quase nunca chega aqui; a
        //        checagem fica porque o dia em que passar a chegar, ela ja vale.
        //
        //    (b) `origem` e o caminho que produziu o payload, declarado por
        //        quem resolveu. E o que de fato barra o Superflix hoje.
        //
        //    Vem antes de tudo: e a recusa que protege a sessao.
        val manifesto = payload.optString("manifest")
        if (manifesto.isNotBlank()) {
            return DownloadElegibilidade.Inelegivel(MotivoInelegivel.SESSAO_DO_NAVEGADOR)
        }
        val origem = payload.optString("origem").lowercase()
        if (origem in ORIGENS_DE_SESSAO) {
            return DownloadElegibilidade.Inelegivel(MotivoInelegivel.SESSAO_DO_NAVEGADOR)
        }

        if (payload.has("error") && payload.optString("error").isNotBlank()) {
            return DownloadElegibilidade.Inelegivel(MotivoInelegivel.SEM_STREAM)
        }

        val stream = payload.optString("stream")
        if (stream.isBlank()) {
            return DownloadElegibilidade.Inelegivel(MotivoInelegivel.SEM_STREAM)
        }

        val parsed = try {
            URL(stream)
        } catch (_: Exception) {
            return DownloadElegibilidade.Inelegivel(MotivoInelegivel.URL_INVALIDA)
        }
        if (parsed.protocol != "https") {
            return DownloadElegibilidade.Inelegivel(MotivoInelegivel.NAO_HTTPS)
        }

        val expiresAt = payload.opt("expiresAt")?.takeIf { it != JSONObject.NULL }
            ?.let { (it as? Number)?.toLong() }
        if (expiresAt != null && expiresAt > 0L && expiresAt - MARGEM_EXPIRACAO_MS <= agora) {
            return DownloadElegibilidade.Inelegivel(MotivoInelegivel.EXPIRADA)
        }

        // O tipo declarado manda; sem ele, a extensao decide. Um master HLS sem
        // ".m3u8" no caminho e comum atras de CDN, entao "nao termina em .mp4"
        // cai em HLS de proposito — o downloader de HLS confere o "#EXTM3U" e
        // falha com MANIFESTO_INVALIDO se errarmos, o que e recuperavel; o
        // contrario gravaria um .mp4 que e texto.
        val tipoDeclarado = payload.optString("tipo").ifBlank { null }
        val kind = when {
            tipoDeclarado != null -> MediaKind.from(tipoDeclarado)
            parsed.path.endsWith(".mp4", ignoreCase = true) -> MediaKind.MP4
            else -> MediaKind.HLS
        }

        return DownloadElegibilidade.Elegivel(
            DownloadSource(
                url = stream,
                referer = payload.optString("referer").ifBlank { null },
                userAgent = payload.optString("userAgent").ifBlank { null },
                kind = kind,
                expiresAt = expiresAt,
            )
        )
    }

    /**
     * [classificar] mais a regra de download: so arquivo direto (MP4) vira
     * download nesta versao.
     *
     * HLS e recusado com [MotivoInelegivel.HLS_SEM_ARQUIVO_UNICO] e o lado web
     * tenta a proxima fonte. E a defesa do lado nativo: mesmo um site antigo, que
     * ainda mande HLS para sondagem, nao produz mais dezenas de `.ts` na pasta.
     *
     * A transmissao continua em [classificar] — o app de cast toca HLS.
     */
    fun paraDownload(payload: JSONObject, agora: Long = System.currentTimeMillis()): DownloadElegibilidade =
        when (val base = classificar(payload, agora)) {
            is DownloadElegibilidade.Inelegivel -> base
            is DownloadElegibilidade.Elegivel ->
                if (base.source.kind == MediaKind.HLS) {
                    DownloadElegibilidade.Inelegivel(MotivoInelegivel.HLS_SEM_ARQUIVO_UNICO)
                } else {
                    base
                }
        }
}
