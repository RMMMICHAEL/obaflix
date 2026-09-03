package com.obaflix.tv.player

import com.obaflix.ObaflixApp
import com.obaflix.bridge.HlsManifest
import com.obaflix.bridge.ObaLog
import com.obaflix.bridge.PlayerExtractors
import com.obaflix.bridge.StreamExtractor
import com.obaflix.bridge.SuperflixChallengeOverlay
import com.obaflix.bridge.SuperflixExtractor
import com.obaflix.bridge.SubtitleTrack
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Episodio
import com.obaflix.tv.ui.PonteDesafio
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
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
    /**
     * A fonte passa por um desafio "nao sou robo" antes de entregar a midia.
     *
     * Vem do `iframeDesafio` da projecao publica, que hoje so o SuperFlix
     * marca. Nao e um nome de provedor — continua sendo "Servidor N" na tela.
     */
    val exigeDesafio: Boolean = false,
    /** Sessão/opção efêmera criada localmente após o bootstrap Superflix. */
    val superflixSession: SuperflixExtractor.Session? = null,
    val superflixOptionKey: String? = null,
    val superflixIsFile: Boolean = false,
) {
    /** "Servidor 2 · Dublado" — o unico enfeite permitido sobre o rotulo. */
    val descricao: String
        get() = when (idioma) {
            "dub" -> if (rotulo.contains("Dublado", true)) rotulo else rotulo + " · Dublado"
            "leg" -> if (rotulo.contains("Legendado", true)) rotulo else rotulo + " · Legendado"
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
    /**
     * User-Agent obrigatorio para esta midia, quando houver.
     *
     * Normalmente null: vale o UA padrao da extracao. Preenchido quando a URL
     * nasceu dentro da WebView do desafio, cujo UA e outro — e o CDN do
     * provedor recusa a playlist quando o par UA/Referer nao e o que gerou o
     * link.
     */
    val userAgent: String? = null,
    /** Alias público da opção que realmente resolveu após renovação/failover. */
    val effectiveOptionKey: String? = null,
    val effectiveOptionLabel: String? = null,
    val effectiveOptionIsFile: Boolean? = null,
    /**
     * Manifesto master ja obtido autorizado pelo contexto do navegador.
     *
     * So o player externo do Superflix preenche. Quando vem, o Media3 recebe
     * este texto em memoria em vez de repetir a requisicao protegida — que
     * responde 403 fora da sessao do Chromium. Vale so para esta reproducao.
     */
    val manifesto: String? = null,
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
        return caminho.endsWith(".m3u8") || ehDaFamiliaUrlset(caminho)
    }

    /**
     * Master do tipo que a conferencia nao pode tocar.
     *
     * A familia `.urlset` com master em `.txt` (StreamWish, Hide e parentes)
     * entrega links que
     * valem para pouquissimas requisicoes: buscar o master para conferir
     * gastava o endereco e o player recebia um 404 — foi o defeito do provedor
     * `wish`. Nestes a conferencia e pulada.
     *
     * O `.m3u8` comum e o oposto: em campo, a fonte que passava pela
     * conferencia chegava a tocar, e a mesma fonte com a conferencia pulada
     * levou 404 em toda tentativa. Entao ele continua sendo conferido. Duas
     * familias de link, dois comportamentos — tratar as duas igual quebrava uma
     * delas em qualquer direcao que se escolhesse.
     */
    private fun ehDaFamiliaUrlset(caminhoEmMinusculas: String): Boolean =
        caminhoEmMinusculas.contains(".urlset/") ||
            caminhoEmMinusculas.endsWith("/master.txt") ||
            caminhoEmMinusculas.endsWith("/playlist.txt")


    /**
     * Teto de tempo da extracao de UMA fonte.
     *
     * Generoso porque alguns provedores exigem desafio de navegador, que demora;
     * finito porque a alternativa e a tela presa em "carregando" sem nunca
     * decidir nada. Estourar aqui e um resultado — o player passa para a
     * proxima fonte em vez de esperar para sempre.
     */
    private const val EXTRACAO_TIMEOUT_MS = 25_000L

    /** Quanto se espera a camada do desafio montar a WebView hospedeira. */
    private const val ESPERA_ANCORA_MS = 4_000L

    /**
     * UA que a midia desta fonte exige, quando ela veio do desafio.
     *
     * So para fonte de desafio: nas demais o UA padrao da extracao ja e o mesmo
     * que gerou o link, e troca-lo criaria o problema em vez de resolver.
     */
    /**
     * Pede a MESMA url de dois jeitos e registra os dois resultados.
     *
     * So em build de diagnostico, e so para fonte de desafio. Serve para
     * responder uma pergunta que hipotese nenhuma resolve: a URL capturada e
     * valida e o problema esta na requisicao do player, ou ela ja nasce
     * recusada e estamos capturando a midia errada?
     *
     *   contexto=webview  UA do sistema (o mesmo da WebView) + cookies do
     *                     CookieManager + Referer capturado
     *   contexto=media3   exatamente os cabecalhos que o player vai mandar
     *
     * 403 nos dois: a fonte capturada nao presta — e midia intermediaria ou de
     * um servidor que nao foi o escolhido, e o extrator devia seguir olhando.
     * 200 no primeiro e 403 no segundo: a diferenca esta na requisicao, e os
     * dois blocos de cabecalho no log dizem qual campo difere.
     *
     * Registra nome de cookie, nunca valor.
     */
    private suspend fun sondarDuasVias(url: String, referer: String?, uaWeb: String?) {
        if (!com.obaflix.tv.BuildConfig.DIAG_LOGS) return
        withContext(Dispatchers.IO) {
            val doPlayer = CabecalhosMidia.de(referer, url, uaWeb)
            val daWebView = buildMap {
                putAll(doPlayer)
                if (uaWeb != null) put("User-Agent", uaWeb)
                runCatching {
                    android.webkit.CookieManager.getInstance().getCookie(url)
                }.getOrNull()?.takeIf { it.isNotBlank() }?.let { put("Cookie", it) }
            }
            listOf("webview" to daWebView, "media3" to doPlayer).forEach { (nome, cabecalhos) ->
                runCatching {
                    val req = Request.Builder().url(url).get()
                        .apply { cabecalhos.forEach { (n, v) -> header(n, v) } }
                        .build()
                    ObaflixApp.httpClient.newCall(req).execute().use { r ->
                        ObaLog.evento(
                            ObaLog.Fase.MANIFESTO, "tv_sonda_desafio",
                            "contexto" to nome,
                            "status" to r.code,
                            "bytes" to (r.body?.contentLength() ?: -1L),
                            "metodo" to "GET",
                            "urlFinal" to ObaLog.url(r.request.url.toString()),
                            "redirecionou" to (r.request.url.toString() != url),
                            "ua" to cabecalhos["User-Agent"]?.take(38),
                            "referer" to ObaLog.url(cabecalhos["Referer"]),
                            "origin" to ObaLog.host(cabecalhos["Origin"]),
                            // Nomes, nunca valores.
                            "cookies" to (cabecalhos["Cookie"]
                                ?.split(";")
                                ?.mapNotNull { it.substringBefore('=').trim().takeIf(String::isNotEmpty) }
                                ?.joinToString(",") ?: "-"),
                            "servidorCdn" to (r.header("Server") ?: "-"),
                        )
                    }
                }.onFailure {
                    ObaLog.alerta(
                        ObaLog.Fase.MANIFESTO, "tv_sonda_desafio_erro",
                        "contexto" to nome, "erro" to it.javaClass.simpleName,
                    )
                }
            }
        }
    }

    private fun uaDoDesafio(fonte: Fonte): String? =
        if (fonte.exigeDesafio) SuperflixChallengeOverlay.uaEmUso else null


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
            val rotulo = f.optString("rotulo").ifBlank { "Servidor" }
            val id = f.optString("id").takeIf { it.isNotBlank() }

            // Por que uma fonte que o site oferece nao aparece aqui.
            //
            // O aplicativo mostrava 5 servidores enquanto o site mostrava mais,
            // e nao havia como saber quais tinham sido descartados nem por que:
            // o descarte era silencioso. Agora cada exclusao diz o motivo, com
            // o rotulo generico que o servidor ja devolve.
            val motivo = when {
                id == null -> "sem_id"
                !f.optBoolean("disponivel", false) ->
                    "indisponivel:" + f.optString("motivoIndisponivel").ifBlank { "-" }
                // `nativo` falso quer dizer que nao ha extrator no aparelho para
                // este provedor: so um navegador abriria. O player da TV e
                // nativo, entao a fonte nao teria como tocar.
                // `resolvidoNoServidor` cobre o provedor cuja resolucao depende
                // de credencial de conta: o aparelho nao extrai, recebe a URL
                // pronta e busca a midia direto no CDN.
                !f.optBoolean("nativo", false) &&
                    !f.optBoolean("resolvidoNoServidor", false) -> "sem_extrator_nativo"
                else -> null
            }
            if (motivo != null) {
                ObaLog.alerta(
                    ObaLog.Fase.EXTRACAO, "tv_fonte_descartada",
                    "servidor" to rotulo,
                    "motivo" to motivo,
                    "nativo" to f.optBoolean("nativo", false),
                    "desafio" to f.optBoolean("iframeDesafio", false),
                    "iframeDireto" to f.optBoolean("iframeDireto", false),
                    "semExtrator" to f.optBoolean("semExtrator", false),
                )
                return@mapNotNull null
            }

            Fonte(
                id = id!!,
                rotulo = rotulo,
                idioma = f.optString("idioma").takeIf { it == "dub" || it == "leg" },
                exigeDesafio = f.optBoolean("iframeDesafio", false),
            )
        }

        ObaLog.evento(
            ObaLog.Fase.EXTRACAO, "tv_fontes",
            "oferecidas" to arr.length(),
            "quantidade" to fontes.size,
            "descartadas" to (arr.length() - fontes.size),
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
    suspend fun resolver(
        sessao: String,
        fonte: Fonte,
        onSuperflixOptions: (List<Fonte>) -> Unit = {},
    ): Midia? {
        // Trilha por servidor: com varias tentativas em sequencia, o log sem
        // separacao vira um emaranhado onde nao da para saber qual servidor
        // produziu qual erro.
        ObaLog.novaTrilha("resolverFonte", "servidor" to fonte.rotulo)

        // Opção interna já listada pelo bootstrap: não volta à API do Obaflix e
        // não abre navegador — exceto quando a opção é o player externo, que
        // só entrega mídia pela própria página.
        fonte.superflixSession?.let { localSession ->
            val optionKey = fonte.superflixOptionKey ?: return null

            // A opção não-arquivo é o player externo, e resolvê-lo passa pelo
            // SuperflixEmbedMediaObserver, que precisa de uma âncora para
            // pendurar a WebView efêmera. A âncora existia só durante o
            // desafio: quando ele terminava, `PonteDesafio.ativo` voltava a
            // false e este ramo — que é por onde passam a segunda opção do
            // failover automático e toda escolha manual — resolvia sem
            // hospedeira nenhuma. O sintoma em campo era "WebView principal
            // indisponivel para o player externo", seguido de
            // `extracao_sem_midia` sem nem um `embed_navigation_start` no log.
            //
            // A opção `is_file` continua sem tocar em WebView: é HTTP puro, e
            // acender a camada nela só piscaria preto na tela à toa.
            val precisaDeAncora = !fonte.superflixIsFile
            if (precisaDeAncora) {
                PonteDesafio.ativo = true
                val apareceu = withTimeoutOrNull(ESPERA_ANCORA_MS) {
                    while (!PonteDesafio.ancoraPronta) delay(50)
                    true
                } == true
                ObaLog.evento(
                    ObaLog.Fase.PROVEDOR, "tv_ancora_opcao_interna",
                    "servidor" to fonte.rotulo, "ancora" to apareceu,
                )
            }

            val result = runCatching {
                StreamExtractor.acceptNativeResult(localSession.resolve(optionKey))
            }.also {
                // Sempre: a câmara não sobrevive à resolução, com mídia ou sem.
                if (precisaDeAncora) PonteDesafio.ativo = false
            }.getOrElse { error ->
                ObaLog.falha(
                    ObaLog.Fase.EXTRACAO, "superflix_candidate_rejected", error,
                    "servidor" to fonte.rotulo,
                    "is_file" to fonte.superflixIsFile,
                )
                return null
            }
            return Midia(
                userAgent = localSession.userAgent,
                ehHls = result.tipo.equals("hls", true) || result.isMaster || pareceHls(result.stream),
                url = result.stream,
                referer = result.referer,
                legendas = result.subtitles.distinctBy { it.file },
                qualidades = result.qualities.distinct(),
                audios = result.audioTracks.distinct(),
                effectiveOptionKey = result.effectiveOptionKey ?: optionKey,
                effectiveOptionLabel = result.effectiveOptionLabel ?: fonte.rotulo,
                effectiveOptionIsFile = result.effectiveOptionIsFile ?: fonte.superflixIsFile,
                manifesto = result.manifest,
            )
        }

        val resposta = ApiObaflix.fonteNativa(sessao, fonte.id)
        if (resposta == null) {
            ObaLog.alerta(
                ObaLog.Fase.EXTRACAO, "tv_fonte_sem_url",
                "servidor" to fonte.rotulo, "fonte" to fonte.id.take(8) + "…",
            )
            return null
        }

        // Midia ja resolvida pelo servidor: nao ha o que extrair aqui. Continua
        // valendo a mesma regra do resto — so conta como sucesso quando o Media3
        // iniciar de fato; se nao iniciar, o failover segue para a proxima.
        resposta.streamUrl?.let { pronta ->
            ObaLog.evento(
                ObaLog.Fase.EXTRACAO, "tv_fonte_resolvida_no_servidor",
                "servidor" to fonte.rotulo,
                "stream" to ObaLog.url(pronta),
                "legendas" to resposta.legendas.size,
                "temReferer" to (resposta.referer != null),
            )
            return Midia(
                ehHls = pareceHls(pronta),
                url = pronta,
                referer = resposta.referer,
                legendas = resposta.legendas.distinctBy { it.file },
                qualidades = emptyList(),
                audios = emptyList(),
            )
        }

        val embed = resposta.embedUrl ?: run {
            ObaLog.alerta(
                ObaLog.Fase.EXTRACAO, "tv_fonte_sem_url",
                "servidor" to fonte.rotulo, "motivo" to "resposta_sem_embed_nem_stream",
            )
            return null
        }

        // O slug interno diz QUAL extrator rodou quando algo falha. Fica so no
        // logcat; na tela o usuario continua vendo "Servidor N".
        val provedor = PlayerExtractors.detectProvider(embed) ?: "desconhecido"
        val comeco = System.currentTimeMillis()

        // Fonte com desafio precisa de uma WebView hospedeira **antes** de o
        // extrator pedir o overlay. A camada e montada aqui e esperada; sem a
        // ancora, o extrator registraria "WebView indisponivel" e ficaria dois
        // minutos esperando algo que nunca viria.
        if (fonte.exigeDesafio) {
            PonteDesafio.ativo = true
            val apareceu = withTimeoutOrNull(ESPERA_ANCORA_MS) {
                while (!PonteDesafio.ancoraPronta) delay(50)
                true
            } == true
            ObaLog.evento(
                ObaLog.Fase.PROVEDOR, "tv_desafio_preparado",
                "servidor" to fonte.rotulo, "ancora" to apareceu,
            )
        }

        // Teto de tempo na extracao. Extrator baseado em WebView pode ficar
        // preso num desafio que nunca resolve, e sem isto a tela fica em
        // "carregando" para sempre — foi o que se viu em campo.
        val extraido = runCatching {
            // Sem teto de tempo quando ha desafio: quem manda no relogio e a
            // pessoa resolvendo o Turnstile, e o proprio extrator ja estende o
            // prazo enquanto o overlay estiver aberto e desiste quando ele e
            // fechado sem escolha.
            if (fonte.exigeDesafio && provedor == "superflix") {
                val prepared = SuperflixExtractor.prepare(embed)
                val localOptions = prepared.options.map { option ->
                    Fonte(
                        id = "sf-local:${option.key}",
                        rotulo = option.label,
                        idioma = when {
                            option.label.contains("Dublado", true) -> "dub"
                            option.label.contains("Legendado", true) -> "leg"
                            else -> null
                        },
                        exigeDesafio = true,
                        superflixSession = prepared,
                        superflixOptionKey = option.key,
                        superflixIsFile = option.isFile,
                    )
                }
                if (localOptions.isEmpty()) throw IllegalStateException("Superflix sem servidores")
                onSuperflixOptions(localOptions)
                // Só a primeira opção é resolvida agora. As demais continuam
                // intactas e serão resolvidas se o usuário escolher ou o player
                // realmente falhar e avançar.
                StreamExtractor.acceptNativeResult(
                    prepared.resolve(localOptions.first().superflixOptionKey!!),
                )
            } else if (fonte.exigeDesafio) {
                StreamExtractor.extract(embed)
            } else {
                withTimeoutOrNull(EXTRACAO_TIMEOUT_MS) { StreamExtractor.extract(embed) }
                    ?: throw IllegalStateException("extracao_estourou_tempo")
            }
        }.also {
            // Desliga a camada assim que a extracao termina — com midia ou sem.
            // O player nativo assume dai em diante; a WebView nao fica viva por
            // tras da reproducao.
            if (fonte.exigeDesafio) PonteDesafio.ativo = false
        }.getOrElse {
            ObaLog.falha(
                ObaLog.Fase.EXTRACAO, "tv_fonte_falhou", it,
                "servidor" to fonte.rotulo, "provedor" to provedor,
                "ms" to (System.currentTimeMillis() - comeco),
            )
            return null
        }

        // `verified` quer dizer que o contexto que obteve a midia ja a consumiu
        // com sucesso. Sondar de novo mediria outra coisa: no player externo do
        // Superflix a mesma URL responde 403 fora da sessao do Chromium, e a
        // sonda so gastaria tempo para registrar um numero que ja conhecemos.
        if (fonte.exigeDesafio && !extraido.verified) {
            sondarDuasVias(extraido.stream, extraido.referer, extraido.userAgent ?: uaDoDesafio(fonte))
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

        // Midia ja provada por quem a obteve: a conferencia nao acrescentaria
        // nada e, quando o manifesto veio junto, ela nem teria como acontecer —
        // o link e da sessao do navegador. Segue direto para o player.
        if (extraido.verified) {
            ObaLog.evento(
                ObaLog.Fase.MANIFESTO, "tv_manifesto_pulado",
                "servidor" to fonte.rotulo, "provedor" to provedor,
                "motivo" to "verificado_no_navegador",
                "manifesto" to (extraido.manifest != null),
            )
            return Midia(
                userAgent = extraido.userAgent ?: uaDoDesafio(fonte),
                ehHls = extraido.tipo.equals("hls", ignoreCase = true) ||
                    extraido.isMaster || pareceHls(extraido.stream),
                url = extraido.stream,
                referer = extraido.referer,
                legendas = extraido.subtitles.distinctBy { it.file },
                qualidades = extraido.qualities.distinct(),
                audios = extraido.audioTracks.distinct(),
                effectiveOptionKey = extraido.effectiveOptionKey,
                effectiveOptionLabel = extraido.effectiveOptionLabel,
                effectiveOptionIsFile = extraido.effectiveOptionIsFile,
                manifesto = extraido.manifest,
            )
        }

        // Quando o endereco ja diz que e HLS, nao se toca nele: a conferencia
        // nao acrescentaria nada (o Media3 tambem le o master, e as variantes
        // aparecem como faixas) e poderia gastar um link de uso unico. A URL e
        // os cabecalhos chegam ao player exatamente como sairam do extrator.
        val hlsPeloEndereco = pareceHls(extraido.stream) || extraido.isMaster ||
            extraido.tipo.equals("hls", ignoreCase = true)
        val usoUnico = ehDaFamiliaUrlset(extraido.stream.substringBefore('?').lowercase())
        if (hlsPeloEndereco && usoUnico) {
            ObaLog.evento(
                ObaLog.Fase.MANIFESTO, "tv_manifesto_pulado",
                "servidor" to fonte.rotulo, "provedor" to provedor,
                "motivo" to "hls_pelo_endereco",
            )
            return Midia(
                userAgent = extraido.userAgent ?: uaDoDesafio(fonte),
                ehHls = true,
                url = extraido.stream,
                referer = extraido.referer,
                legendas = extraido.subtitles.distinctBy { it.file },
                qualidades = extraido.qualities.distinct(),
                audios = extraido.audioTracks.distinct(),
                effectiveOptionKey = extraido.effectiveOptionKey,
                effectiveOptionLabel = extraido.effectiveOptionLabel,
                effectiveOptionIsFile = extraido.effectiveOptionIsFile,
            )
        }

        val conferencia = conferirManifesto(
            extraido.stream,
            extraido.referer,
            extraido.userAgent ?: uaDoDesafio(fonte),
        )
        if (conferencia is Conferencia.Morto) {
            // O provedor respondeu, e respondeu que nao existe. Entregar ao
            // player so adiaria a mesma resposta por quatro tentativas dele.
            ObaLog.alerta(
                ObaLog.Fase.MANIFESTO, "tv_manifesto_morto",
                "servidor" to fonte.rotulo, "provedor" to provedor,
                "status" to conferencia.status,
            )
            return null
        }
        val info = (conferencia as? Conferencia.Viva)?.resumo
        if (info == null) {
            // Duvida nao condena: timeout ou erro de rede na conferencia pode
            // ser da conferencia, e nao da fonte. Quem decide e o Media3.
            ObaLog.alerta(
                ObaLog.Fase.MANIFESTO, "tv_manifesto_inconclusivo",
                "servidor" to fonte.rotulo, "provedor" to provedor,
                "acao" to "entregue_ao_player",
            )
            return Midia(
                userAgent = extraido.userAgent ?: uaDoDesafio(fonte),
                ehHls = hlsPeloEndereco,
                url = extraido.stream,
                referer = extraido.referer,
                legendas = extraido.subtitles.distinctBy { it.file },
                qualidades = extraido.qualities.distinct(),
                audios = extraido.audioTracks.distinct(),
                effectiveOptionKey = extraido.effectiveOptionKey,
                effectiveOptionLabel = extraido.effectiveOptionLabel,
                effectiveOptionIsFile = extraido.effectiveOptionIsFile,
            )
        }

        return Midia(
            userAgent = extraido.userAgent ?: uaDoDesafio(fonte),
            // O corpo confirma, mas o endereco tambem vale: um `.m3u8` que a
            // conferencia nao conseguiu ler continua sendo HLS para o Media3.
            ehHls = info.ehHls || hlsPeloEndereco,
            url = extraido.stream,
            referer = extraido.referer,
            legendas = (extraido.subtitles + info.subtitles).distinctBy { it.file },
            qualidades = (extraido.qualities + info.variants.map { it.label }).distinct(),
            audios = (extraido.audioTracks + info.audioTracks).distinct(),
            effectiveOptionKey = extraido.effectiveOptionKey,
            effectiveOptionLabel = extraido.effectiveOptionLabel,
            effectiveOptionIsFile = extraido.effectiveOptionIsFile,
        )
    }

    /**
     * Confere se o manifesto esta vivo e le o que ele oferece.
     *
     * Custa alguns kilobytes e evita entregar ao player uma URL que ja morreu —
     * o caso mais comum de "carregou e ficou preto". Para MP4 nao ha manifesto:
     * a checagem e so do status, sem baixar o corpo.
     */
    private suspend fun conferirManifesto(
        url: String,
        referer: String?,
        userAgent: String?,
    ): Conferencia =
        withTimeoutOrNull(CONFERENCIA_TIMEOUT_MS) { conferirAgora(url, referer, userAgent) }
            ?: Conferencia.NaoDeuParaSaber

    /** Teto proprio da conferencia: ela e um atalho, nunca uma espera longa. */
    private const val CONFERENCIA_TIMEOUT_MS = 8_000L

    /**
     * Status que significam "este endereco nao existe", e so esses.
     *
     * 403 saiu da lista de proposito. 404 e 410 sao ausencia: nenhum cabecalho
     * inventa um arquivo que nao esta la, entao descartar na hora e certo. Ja o
     * 403 e "existe, mas voce nao pode" — e quem pode ou nao pode depende de
     * cabecalho, cookie, IP e reuso de conexao, que sao justamente as coisas em
     * que a conferencia e o Media3 diferem. Descartar por 403 fazia o player
     * nunca tentar, e com isso nunca dava para saber se ele conseguiria: em
     * campo, um provedor inteiro (dois "servidores" apontando para o mesmo CDN)
     * sumiu assim, sem uma unica tentativa de reproducao registrada.
     */
    private val DEFINITIVOS = setOf(404, 410)

    private suspend fun conferirAgora(
        url: String,
        referer: String?,
        userAgent: String?,
    ): Conferencia =
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
                .apply { CabecalhosMidia.de(referer, url, userAgent).forEach { (n, v) -> header(n, v) } }
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
                            // Num 403 o Referer e a primeira suspeita, e ate
                            // aqui ele nao aparecia em lugar nenhum do log.
                            "referer" to ObaLog.url(referer),
                            "definitivo" to (r.code in DEFINITIVOS),
                        )
                        // Status definitivo do provedor e resposta, nao duvida:
                        // em campo, master.m3u8 que devolve 404 aqui devolve 404
                        // para o player tambem, quatro vezes, e so entao ele
                        // desiste. Descartar agora poupa uns 6s por fonte morta.
                        return@use if (r.code in DEFINITIVOS) {
                            Conferencia.Morto(r.code)
                        } else {
                            Conferencia.NaoDeuParaSaber
                        }
                    }
                    if (ehArquivoBinario) return@use Conferencia.Viva(HlsMediaResumo(ehHls = false))

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
                        return@use Conferencia.Viva(HlsMediaResumo(ehHls = false))
                    }
                    val info = HlsManifest.parse(texto, url)
                    Conferencia.Viva(
                        HlsMediaResumo(
                            variants = info.variants,
                            audioTracks = info.audioTracks,
                            subtitles = info.subtitles,
                            ehHls = true,
                        ),
                    )
                }
            }.getOrElse {
                ObaLog.alerta(
                    ObaLog.Fase.EXTRACAO, "tv_manifesto_sem_resposta",
                    "erro" to it.javaClass.simpleName,
                )
                Conferencia.NaoDeuParaSaber
            }
        }

    private fun origemDe(referer: String): String = runCatching {
        val u = java.net.URL(referer)
        u.protocol + "://" + u.host
    }.getOrDefault(referer)
}

/**
 * Desfecho da conferencia.
 *
 * Tres estados, e nao dois, porque "o provedor disse que nao existe" e "nao
 * consegui perguntar" pedem acoes opostas: a primeira descarta a fonte na hora,
 * a segunda entrega ao player e deixa ele julgar.
 */
sealed interface Conferencia {
    data class Viva(val resumo: HlsMediaResumo) : Conferencia
    data class Morto(val status: Int) : Conferencia
    object NaoDeuParaSaber : Conferencia
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
    fun de(
        referer: String?,
        urlMidia: String? = null,
        /**
         * UA obrigatorio desta midia, quando ela nasceu com outro.
         *
         * O padrao serve a extracao por HTTP. Midia capturada dentro da WebView
         * do desafio nasce com o UA do sistema, e o CDN do provedor amarra o
         * link ao UA que o gerou: pedir com o nosso devolve 403.
         */
        userAgent: String? = null,
    ): Map<String, String> = buildMap {
        // O UA tambem vai no mapa, e nao apenas em setUserAgent(): a checagem de
        // manifesto e o player precisam mandar exatamente o mesmo par.
        put("User-Agent", userAgent ?: USER_AGENT)
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
                // Referer com caminho (sem query): mandar a pagina do embed e
                // mandar so a origem sao coisas diferentes para varios CDN, e
                // com `host` as duas apareciam identicas no log.
                "Referer" -> nome + "=" + ObaLog.url(valor)
                "Origin" -> nome + "=" + ObaLog.host(valor)
                "User-Agent" -> "UA=" + valor.take(24) + "…"
                else -> nome + "=" + valor
            }
        }
}
