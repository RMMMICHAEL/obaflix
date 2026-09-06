package com.obaflix.cast

import com.obaflix.download.DownloadElegibilidade
import com.obaflix.download.DownloadSourceResolver
import com.obaflix.download.MediaKind
import com.obaflix.download.MotivoInelegivel
import org.json.JSONObject

/**
 * Uma fonte que pode ser entregue a um aplicativo externo de transmissao.
 *
 * Carrega URL e os dois headers que autorizam a midia, e **nada alem disso**.
 * Nao existe campo de cookie nesta classe de proposito: se um dia alguem
 * precisar de um, a discussao sobre entregar sessao a outro processo acontece
 * antes, na revisao do tipo, e nao escondida dentro de um mapa de headers.
 */
data class CastSource(
    val url: String,
    val referer: String?,
    val userAgent: String?,
    val kind: MediaKind,
    val titulo: String,
    val poster: String?,
) {
    /** MIME que o app externo usa para escolher o demuxer. */
    val mimeType: String
        get() = if (kind == MediaKind.HLS) "application/x-mpegURL" else "video/mp4"
}

enum class MotivoSemCast {
    /** A midia so vive dentro da sessao do navegador — ver [MotivoInelegivel.SESSAO_DO_NAVEGADOR]. */
    SESSAO_DO_NAVEGADOR,
    SEM_STREAM,
    NAO_HTTPS,
    EXPIRADA,
    URL_INVALIDA,
}

sealed class CastElegibilidade {
    data class Elegivel(val source: CastSource) : CastElegibilidade()
    data class Inelegivel(val motivo: MotivoSemCast) : CastElegibilidade()
}

/**
 * Decide se a fonte resolvida pode ser compartilhada com outro aplicativo.
 *
 * ## Por que reaproveita o classificador de download
 *
 * A pergunta e a mesma nos dois casos: *esta midia continua valida fora do
 * contexto que a autorizou?* Um manifesto preso a sessao do Chromium falha
 * igual no OkHttp do download e no player do Web Video Cast — os dois sao
 * "outro cliente" do ponto de vista do CDN. Duplicar a regra criaria a chance
 * de um dos dois lados ficar mais permissivo que o outro numa mudanca futura,
 * e o lado mais permissivo seria justamente o que entrega a fonte a um processo
 * de terceiro.
 *
 * O que o cast acrescenta e a consequencia de falhar: o download falha dentro
 * do app, com um erro nosso; o cast entrega a URL a um processo que nao
 * controlamos. Por isso a recusa aqui e final — nao ha tentativa "de qualquer
 * jeito".
 */
object CastSourceResolver {

    fun classificar(
        payload: JSONObject,
        titulo: String,
        poster: String? = null,
        agora: Long = System.currentTimeMillis(),
    ): CastElegibilidade =
        when (val base = DownloadSourceResolver.classificar(payload, agora)) {
            is DownloadElegibilidade.Elegivel -> CastElegibilidade.Elegivel(
                CastSource(
                    url = base.source.url,
                    referer = base.source.referer,
                    userAgent = base.source.userAgent,
                    kind = base.source.kind,
                    titulo = titulo,
                    poster = poster?.takeIf { it.startsWith("https://") },
                )
            )

            is DownloadElegibilidade.Inelegivel -> CastElegibilidade.Inelegivel(
                when (base.motivo) {
                    MotivoInelegivel.SESSAO_DO_NAVEGADOR -> MotivoSemCast.SESSAO_DO_NAVEGADOR
                    MotivoInelegivel.SEM_STREAM -> MotivoSemCast.SEM_STREAM
                    MotivoInelegivel.NAO_HTTPS -> MotivoSemCast.NAO_HTTPS
                    MotivoInelegivel.EXPIRADA -> MotivoSemCast.EXPIRADA
                    MotivoInelegivel.URL_INVALIDA -> MotivoSemCast.URL_INVALIDA
                }
            )
        }
}
