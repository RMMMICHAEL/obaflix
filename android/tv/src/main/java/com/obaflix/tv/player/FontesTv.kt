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
import kotlinx.coroutines.withTimeoutOrNull
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
    /**
     * Se o conteudo e HLS, decidido pelo **corpo** e nao pela extensao.
     *
     * Varios provedores servem o master numa URL terminada em `.txt` — o
     * padrao `.urlset/master.txt` do StreamWish e do Hide, por exemplo. O
     * Media3 infere o tipo pela extensao da URI: com `.txt` ele escolhe o
     * leitor progressivo, que nao entende playlist, e falha em milissegundos.
     * Este campo e o que permite dizer a ele o tipo certo.
     */
    val ehHls: Boolean = false,
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
     * Extensoes que sao arquivo de midia, e nao playlist.
     *
     * Fora desta lista, a conferencia le o corpo antes de decidir — inclusive
     * `.txt`, que e como varios provedores entregam o master HLS.
     */
    private val BINARIOS = listOf(".mp4", ".mkv", ".webm", ".avi", ".mov", ".ts", ".m4v")

    /**
     * Reconhece um master HLS pelo formato do endereco, sem tocar na rede.
     *
     * `.urlset/master.txt` e como StreamWish, Hide e parentes entregam o master:
     * extensao `.txt`, conteudo de playlist. Saber disso de antemao evita a
     * unica coisa que a conferencia nao pode fazer — gastar a URL. Varios desses
     * links valem para uma requisicao so, ou expiram em segundos: quando a
     * conferencia buscava o master, o player recebia um endereco ja queimado e
     * levava 404. Era exatamente o caso do provedor `wish`.
     */
    private fun pareceHls(url: String): Boolean {
        val caminho = url.substringBefore('?').lowercase()
        return caminho.endsWith(".m3u8") ||
            caminho.contains(".urlset/") ||
            caminho.endsWith("/master.txt") ||
            caminho.endsWith("/playlist.txt")
    }


    /**
     * Teto de tempo da extracao de UMA fonte.
     *
     * Generoso porque alguns provedores exigem desafio de navegador, que demora;
     * finito porque a alternativa e a tela presa em "carregando" sem nunca
     * decidir nada. Estourar aqui e um resultado — o player passa para a
     * proxima fonte em vez de esperar para sempre.
     */
    private const val EXTRACAO_TIMEOUT_MS = 25_000L


    /**
     * Fontes utilizaveis na televisao.
     *
     * Filtra o que exige navegador: `iframeDireto` e `iframeDesafio` dependem de
     * uma WebView visivel (o desafio do Cloudflare, no caso do segundo), e o
     * player de TV e nativo. Oferecer um "Servidor 4" que nunca abre e pior do
     * que nao oferecer.
     */
    /**
     * Registra o provedor de TLS em uso, uma vez por processo.
     *
     * A confirmacao que a instalacao do Conscrypt emite sai no `onCreate` da
     * Application — antes de qualquer logcat anexado depois da abertura do
     * aplicativo. Repetir aqui torna possivel conferir, num log capturado no
     * meio da sessao, se o TLS 1.3 esta mesmo disponivel neste aparelho.
     */
    private var tlsRegistrado = false

    private fun registrarTls() {
        if (tlsRegistrado) return
        tlsRegistrado = true
        val provedor = runCatching {
            javax.net.ssl.SSLContext.getDefault().provider.name
        }.getOrDefault("?")
        val protocolos = runCatching {
            javax.net.ssl.SSLContext.getDefault().defaultSSLParameters.protocols.joinToString(",")
        }.getOrDefault("?")
        ObaLog.evento(
            ObaLog.Fase.SESSAO, "tv_tls_em_uso",
            "provedor" to provedor,
            "protocolos" to protocolos,
            "sdk" to android.os.Build.VERSION.SDK_INT,
        )
    }

    suspend fun abrir(pedido: Pedido): SessaoFontes? {
        registrarTls()
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
        // Trilha por servidor: com varias tentativas em sequencia, o log sem
        // separacao vira um emaranhado onde nao da para saber qual servidor
        // produziu qual erro.
        ObaLog.novaTrilha("resolverFonte", "servidor" to fonte.rotulo)

        val embed = ApiObaflix.fonteNativa(sessao, fonte.id)
        if (embed == null) {
            ObaLog.alerta(
                ObaLog.Fase.EXTRACAO, "tv_fonte_sem_url",
                "servidor" to fonte.rotulo, "fonte" to fonte.id.take(8) + "…",
            )
            return null
        }

        // O slug interno diz QUAL extrator rodou quando algo falha. Fica so no
        // logcat; na tela o usuario continua vendo "Servidor N".
        val provedor = PlayerExtractors.detectProvider(embed) ?: "desconhecido"
        val comeco = System.currentTimeMillis()

        // Teto de tempo na extracao. Extrator baseado em WebView pode ficar
        // preso num desafio que nunca resolve, e sem isto a tela fica em
        // "carregando" para sempre — foi o que se viu em campo.
        val extraido = runCatching {
            withTimeoutOrNull(EXTRACAO_TIMEOUT_MS) { StreamExtractor.extract(embed) }
                ?: throw IllegalStateException("extracao_estourou_tempo")
        }.getOrElse {
            ObaLog.falha(
                ObaLog.Fase.EXTRACAO, "tv_fonte_falhou", it,
                "servidor" to fonte.rotulo, "provedor" to provedor,
                "ms" to (System.currentTimeMillis() - comeco),
            )
            return null
        }

        ObaLog.evento(
            ObaLog.Fase.EXTRACAO, "tv_fonte_extraida",
            "servidor" to fonte.rotulo,
            "provedor" to provedor,
            "tipo" to (extraido.tipo ?: "-"),
            "master" to extraido.isMaster,
            "temReferer" to (extraido.referer != null),
            "stream" to ObaLog.url(extraido.stream),
            "ms" to (System.currentTimeMillis() - comeco),
        )

        // Quando o endereco ja diz que e HLS, nao se toca nele: a conferencia
        // nao acrescentaria nada (o Media3 tambem le o master, e as variantes
        // aparecem como faixas) e poderia gastar um link de uso unico. A URL e
        // os cabecalhos chegam ao player exatamente como sairam do extrator.
        val hlsPeloEndereco = pareceHls(extraido.stream) || extraido.isMaster ||
            extraido.tipo.equals("hls", ignoreCase = true)
        if (hlsPeloEndereco) {
            ObaLog.evento(
                ObaLog.Fase.MANIFESTO, "tv_manifesto_pulado",
                "servidor" to fonte.rotulo, "provedor" to provedor,
                "motivo" to "hls_pelo_endereco",
            )
            return Midia(
                ehHls = true,
                url = extraido.stream,
                referer = extraido.referer,
                legendas = extraido.subtitles.distinctBy { it.file },
                qualidades = extraido.qualities.distinct(),
                audios = extraido.audioTracks.distinct(),
            )
        }

        val info = conferirManifesto(extraido.stream, extraido.referer)
        if (info == null) {
            // Conferencia inconclusiva nao condena mais a fonte. Quem decide se
            // a midia presta e o Media3, que agora espera de verdade por READY;
            // recusar aqui derrubava fonte boa por causa de um 404 que era da
            // propria conferencia, e nao da reproducao.
            ObaLog.alerta(
                ObaLog.Fase.MANIFESTO, "tv_manifesto_inconclusivo",
                "servidor" to fonte.rotulo, "provedor" to provedor,
                "acao" to "entregue_ao_player",
            )
            return Midia(
                ehHls = false,
                url = extraido.stream,
                referer = extraido.referer,
                legendas = extraido.subtitles.distinctBy { it.file },
                qualidades = extraido.qualities.distinct(),
                audios = extraido.audioTracks.distinct(),
            )
        }

        return Midia(
            ehHls = info.ehHls,
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
        withTimeoutOrNull(CONFERENCIA_TIMEOUT_MS) { conferirAgora(url, referer) }

    /** Teto proprio da conferencia: ela e um atalho, nunca uma espera longa. */
    private const val CONFERENCIA_TIMEOUT_MS = 8_000L

    private suspend fun conferirAgora(url: String, referer: String?): HlsMediaResumo? =
        withContext(Dispatchers.IO) {
            // Range so em arquivo de midia de verdade. Playlist com Range volta
            // 404 em alguns CDN (visto no Cloudflare), e ai uma fonte boa era
            // descartada por causa da propria conferencia.
            val caminho = url.substringBefore('?').lowercase()
            val ehArquivoBinario = BINARIOS.any { caminho.endsWith(it) }

            val requisicao = Request.Builder()
                .url(url)
                // Exatamente os mesmos cabecalhos do player. Conferir com um
                // conjunto e reproduzir com outro daria um "manifesto vivo" que
                // o ExoPlayer nao consegue abrir.
                .apply { CabecalhosMidia.de(referer, url).forEach { (n, v) -> header(n, v) } }
                .apply {
                    // GET sempre, nunca HEAD: CDN da AWS (CloudFront e afins)
                    // recusa HEAD com 403 mesmo quando o GET funciona, porque a
                    // assinatura da URL cobre o metodo.
                    get()
                    // Em video, dois bytes bastam para saber que esta vivo.
                    if (ehArquivoBinario) header("Range", "bytes=0-1")
                }
                .build()

            runCatching {
                // `httpClient`, e nao `mediaClient`: o de midia tem readTimeout
                // zero de proposito (corpo consumido devagar pelo player), e uma
                // conferencia com timeout infinito trava a tela sem nunca falhar.
                ObaflixApp.httpClient.newCall(requisicao).execute().use { r ->
                    if (!r.isSuccessful) {
                        ObaLog.alerta(
                            ObaLog.Fase.MANIFESTO, "tv_manifesto_recusado",
                            "status" to r.code,
                            "metodo" to (if (ehArquivoBinario) "GET/Range" else "GET"),
                            "host" to ObaLog.host(url),
                            "servidorCdn" to (r.header("Server") ?: "-"),
                        )
                        return@use null
                    }
                    if (ehArquivoBinario) return@use HlsMediaResumo(ehHls = false)

                    // Quem decide se e HLS e o corpo, nao a extensao. Um master
                    // servido como `.txt` continua sendo um master.
                    val texto = r.body?.string().orEmpty()
                    if (!HlsManifest.looksLikeManifest(texto)) {
                        // Nao e playlist e nao tem extensao de video: pode ser
                        // um MP4 sem extensao. Responder 200 ja e prova de vida;
                        // o player descobre o formato sozinho.
                        ObaLog.evento(
                            ObaLog.Fase.MANIFESTO, "tv_corpo_nao_e_playlist",
                            "host" to ObaLog.host(url), "bytes" to texto.length,
                        )
                        return@use HlsMediaResumo(ehHls = false)
                    }
                    val info = HlsManifest.parse(texto, url)
                    HlsMediaResumo(
                        variants = info.variants,
                        audioTracks = info.audioTracks,
                        subtitles = info.subtitles,
                        ehHls = true,
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
    /** Confirmado pelo corpo da resposta, nao pela extensao da URL. */
    val ehHls: Boolean = false,
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

    /**
     * O conjunto completo, e nao so Referer.
     *
     * Cada linha aqui existe porque algum CDN recusou sem ela — a referencia e
     * o `fetchCdnDirect` do aplicativo movel, que atravessa os mesmos
     * provedores hoje. A televisao mandava um subconjunto, e o resultado em
     * campo foi um servidor funcionando e os demais devolvendo 403.
     *
     * Mandar a mais nao quebra provedor nenhum; mandar a menos quebra varios, e
     * em silencio: o ExoPlayer so diz "fonte de erro", nunca "faltou Cookie".
     *
     * `urlMidia` entra so para escolher o cookie certo — nada dela e logado.
     */
    fun de(referer: String?, urlMidia: String? = null): Map<String, String> = buildMap {
        // O UA tambem vai no mapa, e nao apenas em setUserAgent(): a checagem de
        // manifesto e o player precisam mandar exatamente o mesmo par.
        put("User-Agent", USER_AGENT)
        put("Accept", "*/*")
        put("Accept-Language", "pt-BR,pt;q=0.5,en-US;q=0.3,en;q=0.2")
        // Sem estes, CDN com deteccao de robo responde 403: a requisicao nao se
        // parece com a de um navegador de verdade.
        put("Sec-Fetch-Dest", "empty")
        put("Sec-Fetch-Mode", "cors")
        put("Sec-Fetch-Site", "cross-site")

        // Quando o extrator nao devolve Referer, vale o que ele guardou no
        // estado — e o mesmo valor que o aplicativo movel usa, e cobre os
        // provedores cujo extrator nao preenche o campo do resultado.
        val efetivo = referer?.takeIf { it.isNotBlank() }
            ?: ObaflixApp.playerState.embedReferer?.takeIf { it.isNotBlank() }

        if (efetivo != null) {
            put("Referer", efetivo)
            // Origin sai do Referer, nao da URL da midia: o provedor valida
            // contra o site que hospeda o player, nao contra o proprio CDN.
            runCatching {
                val u = java.net.URL(efetivo)
                put("Origin", u.protocol + "://" + u.host)
            }
        }

        // Ha provedor que assina a sessao em cookie durante a extracao. Sem
        // repassar, o link extraido vale para uma sessao que o player nao tem.
        if (urlMidia != null) {
            runCatching {
                android.webkit.CookieManager.getInstance().getCookie(urlMidia)
            }.getOrNull()?.takeIf { it.isNotBlank() }?.let { put("Cookie", it) }
        }
    }

    /** Resumo para log: sem valor de cookie, sem querystring. */
    fun resumo(cabecalhos: Map<String, String>): String =
        cabecalhos.entries.joinToString(" ") { (nome, valor) ->
            when (nome) {
                "Cookie" -> "Cookie=<" + valor.length + "b>"
                "Referer", "Origin" -> nome + "=" + ObaLog.host(valor)
                "User-Agent" -> "UA=" + valor.take(24) + "…"
                else -> nome + "=" + valor
            }
        }
}
