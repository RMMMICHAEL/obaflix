package com.obaflix.tv.player

import com.obaflix.ObaflixApp
import com.obaflix.bridge.HlsManifest
import com.obaflix.bridge.ObaLog
import com.obaflix.bridge.PlayerExtractors
import com.obaflix.bridge.StreamExtractor
import com.obaflix.bridge.SubtitleTrack
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Episodio
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

/**
 * O que a televisao pede para reproduzir.
 *
 * Carrega a lista de episodios junto porque a faixa que abre com a seta para
 * baixo, durante a reproducao, precisa dela sem voltar ao servidor — trocar de
 * episodio no meio do filme nao pode custar uma consulta e uma espera.
 */
data class Pedido(
    val conteudoId: String,
    val conteudoTipo: String,
    val titulo: String,
    val backdrop: String?,
    val temporada: Int? = null,
    val numeroEp: Int? = null,
    val episodioId: String? = null,
    val tituloEpisodio: String? = null,
    val posicaoSeg: Int = 0,
    val episodios: List<Episodio> = emptyList(),
) {
    val ehSerie: Boolean get() = conteudoTipo != "filme"

    val rotuloCompleto: String
        get() = if (temporada != null && numeroEp != null) {
            titulo + "  ·  T" + temporada + " E" + numeroEp
        } else {
            titulo
        }
}

/**
 * Uma fonte, do jeito que o usuario comum a ve.
 *
 * `rotulo` vem do servidor ja como "Servidor 1", "Servidor 2". O aparelho nao
 * conhece — e nao tem como descobrir — o nome real do provedor: a projecao
 * publica da rota nao inclui provider, host nem embedUrl. Nada aqui inventa um
 * nome mais bonito, porque o rotulo generico e a protecao.
 */
data class Fonte(
    val id: String,
    val rotulo: String,
    val idioma: String?,
) {
    /** "Servidor 2 · Dublado" — o unico enfeite permitido sobre o rotulo. */
    val descricao: String
        get() = when (idioma) {
            "dub" -> rotulo + " · Dublado"
            "leg" -> rotulo + " · Legendado"
            else -> rotulo
        }
}

/** Sessao de reproducao aberta no servidor. */
data class SessaoFontes(val sessao: String, val fontes: List<Fonte>)

/** Midia pronta para o player, com o que o CDN vai exigir em cada requisicao. */
data class Midia(
    val url: String,
    val referer: String?,
    val legendas: List<SubtitleTrack>,
    val qualidades: List<String>,
    val audios: List<String>,
)

/**
 * Ponte entre o catalogo e o player.
 *
 * O caminho e o mesmo do Electron e do aplicativo movel, com os mesmos passos e
 * na mesma ordem:
 *
 *  1. abrir a sessao de fontes (`/api/player/fontes`, ambiente "android");
 *  2. resolver **uma** fonte por vez (`/api/player/fonte-nativa`);
 *  3. extrair no proprio aparelho, com o extrator compartilhado do
 *     `:core-extractor` — o CDN dos provedores recusa IP de datacenter, entao a
 *     Vercel nao consegue fazer isso, e passar a midia pelo proxy custaria
 *     centenas de MB de Transfer Out por episodio;
 *  4. conferir se o manifesto esta vivo antes de entregar ao player.
 *
 * O passo 4 e o que permite trocar de servidor **antes** de a pessoa ver a tela
 * preta: um master que responde 404 ou vem vazio e descartado aqui, e o player
 * tenta o proximo sozinho.
 */
object FontesTv {

    /**
     * Fontes utilizaveis na televisao.
     *
     * Filtra o que exige navegador: `iframeDireto` e `iframeDesafio` dependem de
     * uma WebView visivel (o desafio do Cloudflare, no caso do segundo), e o
     * player de TV e nativo. Oferecer um "Servidor 4" que nunca abre e pior do
     * que nao oferecer.
     */
    suspend fun abrir(pedido: Pedido): SessaoFontes? {
        val raiz = ApiObaflix.fontes(
            conteudoId = pedido.conteudoId,
            conteudoTipo = if (pedido.ehSerie) "serie" else "filme",
            temporada = pedido.temporada,
            numeroEp = pedido.numeroEp,
        ) ?: return null

        val sessao = raiz.optString("sessao").takeIf { it.isNotBlank() } ?: return null
        val arr = raiz.optJSONArray("fontes") ?: return SessaoFontes(sessao, emptyList())

        val fontes = (0 until arr.length()).mapNotNull { i ->
            val f = arr.optJSONObject(i) ?: return@mapNotNull null
            if (!f.optBoolean("disponivel", false)) return@mapNotNull null
            if (!f.optBoolean("nativo", false)) return@mapNotNull null
            val id = f.optString("id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            Fonte(
                id = id,
                rotulo = f.optString("rotulo").ifBlank { "Servidor" },
                idioma = f.optString("idioma").takeIf { it == "dub" || it == "leg" },
            )
        }

        ObaLog.evento(
            ObaLog.Fase.EXTRACAO, "tv_fontes",
            "quantidade" to fontes.size,
            "tipo" to (if (pedido.ehSerie) "serie" else "filme"),
        )
        return SessaoFontes(sessao, fontes)
    }

    /**
     * Resolve e extrai uma fonte.
     *
     * Devolve null em qualquer falha — quem chama tenta a proxima. A URL real
     * nunca aparece em log: `ObaLog.url` ja reduz a host quando o extrator
     * registra, e aqui nao ha registro nenhum do endereco.
     */
    suspend fun resolver(sessao: String, fonte: Fonte): Midia? {
        val embed = ApiObaflix.fonteNativa(sessao, fonte.id) ?: return null

        val extraido = runCatching { StreamExtractor.extract(embed) }.getOrElse {
            ObaLog.alerta(
                ObaLog.Fase.EXTRACAO, "tv_fonte_falhou",
                "fonte" to fonte.rotulo, "erro" to it.javaClass.simpleName,
            )
            return null
        }

        val info = conferirManifesto(extraido.stream, extraido.referer) ?: return null

        return Midia(
            url = extraido.stream,
            referer = extraido.referer,
            legendas = (extraido.subtitles + info.subtitles).distinctBy { it.file },
            qualidades = (extraido.qualities + info.variants.map { it.label }).distinct(),
            audios = (extraido.audioTracks + info.audioTracks).distinct(),
        )
    }

    /**
     * Confere se o manifesto esta vivo e le o que ele oferece.
     *
     * Custa alguns kilobytes e evita entregar ao player uma URL que ja morreu —
     * o caso mais comum de "carregou e ficou preto". Para MP4 nao ha manifesto:
     * a checagem e so do status, sem baixar o corpo.
     */
    private suspend fun conferirManifesto(url: String, referer: String?): HlsMediaResumo? =
        withContext(Dispatchers.IO) {
            val pedeManifesto = url.substringBefore('?').endsWith(".m3u8", ignoreCase = true)

            val requisicao = Request.Builder()
                .url(url)
                .header("User-Agent", CabecalhosMidia.USER_AGENT)
                .apply { referer?.let { header("Referer", it); header("Origin", origemDe(it)) } }
                .apply { if (!pedeManifesto) head() else get() }
                .build()

            runCatching {
                ObaflixApp.mediaClient.newCall(requisicao).execute().use { r ->
                    if (!r.isSuccessful) {
                        ObaLog.alerta(
                            ObaLog.Fase.EXTRACAO, "tv_manifesto_recusado",
                            "status" to r.code,
                        )
                        return@use null
                    }
                    if (!pedeManifesto) return@use HlsMediaResumo()

                    val texto = r.body?.string().orEmpty()
                    if (!HlsManifest.looksLikeManifest(texto)) {
                        ObaLog.alerta(ObaLog.Fase.EXTRACAO, "tv_manifesto_invalido")
                        return@use null
                    }
                    val info = HlsManifest.parse(texto, url)
                    HlsMediaResumo(
                        variants = info.variants,
                        audioTracks = info.audioTracks,
                        subtitles = info.subtitles,
                    )
                }
            }.getOrElse {
                ObaLog.alerta(
                    ObaLog.Fase.EXTRACAO, "tv_manifesto_sem_resposta",
                    "erro" to it.javaClass.simpleName,
                )
                null
            }
        }

    private fun origemDe(referer: String): String = runCatching {
        val u = java.net.URL(referer)
        u.protocol + "://" + u.host
    }.getOrDefault(referer)
}

/** Recorte do que o manifesto declarou. Vazio quando a midia e MP4. */
data class HlsMediaResumo(
    val variants: List<com.obaflix.bridge.HlsVariant> = emptyList(),
    val audioTracks: List<String> = emptyList(),
    val subtitles: List<SubtitleTrack> = emptyList(),
)

/**
 * Cabecalhos que acompanham cada requisicao ao CDN.
 *
 * No site quem faz essa requisicao e o proxy da Vercel; no Electron, o processo
 * principal injeta em `onBeforeSendHeaders`; no aplicativo movel, a WebView por
 * `shouldInterceptRequest`. Na televisao e o proprio ExoPlayer, entao os
 * cabecalhos entram na fonte de dados. Ambiente diferente, comportamento
 * observavel igual: o CDN recebe o Referer do host que **respondeu**.
 */
object CabecalhosMidia {
    /**
     * O mesmo User-Agent da extracao, e nao um proprio.
     *
     * Ha CDN que amarra o link ao par User-Agent/Referer com que ele foi
     * gerado. Um UA diferente na requisicao do segmento vira 403 no meio do
     * video, sem mensagem nenhuma — o tipo de defeito que so aparece em um
     * provedor e demora semanas para ser entendido.
     */
    val USER_AGENT: String = PlayerExtractors.UA_EXTRACAO

    fun de(referer: String?): Map<String, String> = buildMap {
        put("Accept", "*/*")
        if (referer != null) {
            put("Referer", referer)
            runCatching {
                val u = java.net.URL(referer)
                put("Origin", u.protocol + "://" + u.host)
            }
        }
    }
}
