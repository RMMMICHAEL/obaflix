package com.obaflix.tv.ui

import android.net.Uri
import android.view.ViewGroup
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.ObaflixApp
import com.obaflix.bridge.ObaLog
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.Episodio
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.player.CabecalhosMidia
import com.obaflix.tv.player.Fonte
import com.obaflix.tv.player.FontesTv
import com.obaflix.tv.player.GravadorProgresso
import com.obaflix.tv.player.Pedido
import com.obaflix.tv.ui.componentes.EspacoH
import com.obaflix.tv.ui.componentes.EspacoV
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Camadas do player.
 *
 * O player nao usa o foco do Compose: usa uma maquina de estados de quatro
 * posicoes, e o controle remoto conversa direto com ela. E deliberado. Foco em
 * cima de video vira loteria — o cursor cai em botao invisivel, some quando os
 * controles se escondem e reaparece em outro canto. Com camada explicita, cada
 * tecla tem um destino conhecido em cada estado, e a mesma seta faz sempre a
 * mesma coisa.
 */
private enum class Camada { Nenhuma, Controles, Episodios, Opcoes }

/** Proporcoes de tela oferecidas, na ordem em que o botao as percorre. */
private val PROPORCOES = listOf(
    "Ajustar" to AspectRatioFrameLayout.RESIZE_MODE_FIT,
    "Preencher" to AspectRatioFrameLayout.RESIZE_MODE_FILL,
    "Ampliar" to AspectRatioFrameLayout.RESIZE_MODE_ZOOM,
)

private const val SALTO_MS = 10_000L
private const val ESCONDER_MS = 5_000L
private const val SALVAR_A_CADA_MS = 30_000L

/**
 * Player de televisao.
 *
 * A extracao roda no aparelho, com o extrator compartilhado; a URL real da
 * midia nunca aparece na tela, no log ou em qualquer rotulo. O que a pessoa le
 * e "Servidor 1", "Servidor 2" — o mesmo que o servidor devolve na projecao
 * publica.
 */
@Composable
fun TelaPlayer(pedido: Pedido) {
    val context = LocalContext.current
    val escopo = rememberCoroutineScope()
    val teclado = remember { FocusRequester() }

    // ── Estado de reproducao ─────────────────────────────────────────────────
    var sessao by remember { mutableStateOf<String?>(null) }
    var fontes by remember { mutableStateOf<List<Fonte>>(emptyList()) }
    var fonteAtual by remember { mutableStateOf(0) }
    var carregando by remember { mutableStateOf(true) }
    var falha by remember { mutableStateOf<String?>(null) }

    var episodioAtual by remember { mutableStateOf(pedido.episodioId) }
    var temporadaAtual by remember { mutableStateOf(pedido.temporada) }
    var numeroAtual by remember { mutableStateOf(pedido.numeroEp) }
    var tituloAtual by remember { mutableStateOf(pedido.rotuloCompleto) }

    // Posicao viva. Comeca no progresso sincronizado e, a partir do primeiro
    // segundo reproduzido, e ela — nunca o valor inicial — que uma troca de
    // servidor, qualidade ou idioma retoma. Voltar ao ponto de origem depois de
    // meia hora de filme e o pior defeito possivel num failover.
    var posicaoMs by remember { mutableStateOf(pedido.posicaoSeg * 1000L) }
    var duracaoMs by remember { mutableStateOf(0L) }
    var tocando by remember { mutableStateOf(true) }

    // ── Estado da interface ──────────────────────────────────────────────────
    var camada by remember { mutableStateOf(Camada.Nenhuma) }
    var proporcao by remember { mutableStateOf(0) }
    var epSelecionado by remember { mutableStateOf(0) }
    var grupoSel by remember { mutableStateOf(0) }
    var opcaoSel by remember { mutableStateOf(0) }
    var ultimaTecla by remember { mutableStateOf(System.currentTimeMillis()) }

    var faixasAudio by remember { mutableStateOf<List<Faixa>>(emptyList()) }
    var faixasTexto by remember { mutableStateOf<List<Faixa>>(emptyList()) }
    var alturas by remember { mutableStateOf<List<Int>>(emptyList()) }
    var audioEscolhido by remember { mutableStateOf(0) }
    var textoEscolhido by remember { mutableStateOf(0) }
    var alturaEscolhida by remember { mutableStateOf(0) }

    // ── Motor ────────────────────────────────────────────────────────────────

    val fabricaHttp = remember {
        // Mesmo cliente da extracao: um pool de conexoes so. O `mediaClient` tem
        // readTimeout zero, que e o que um corpo de midia consumido devagar
        // exige — com o timeout comum, o video morre assim que o buffer enche.
        OkHttpDataSource.Factory(ObaflixApp.mediaClient)
            .setUserAgent(CabecalhosMidia.USER_AGENT)
    }

    val player = remember {
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(fabricaHttp))
            .setSeekBackIncrementMs(SALTO_MS)
            .setSeekForwardIncrementMs(SALTO_MS)
            .build()
    }

    val vista = remember {
        PlayerView(context).apply {
            useController = false
            // Quem comanda o player e o Box com onPreviewKeyEvent; o PlayerView
            // nao pode receber foco, senao rouba o D-pad da maquina de camadas.
            isFocusable = false
            isFocusableInTouchMode = false
            descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setShutterBackgroundColor(android.graphics.Color.BLACK)
            this.player = player
        }
    }

    fun salvarProgresso() {
        GravadorProgresso.salvar(
            conteudoId = pedido.conteudoId,
            conteudoTipo = if (pedido.ehSerie) "serie" else "filme",
            progressoSeg = (posicaoMs / 1000).toInt(),
            duracaoSeg = (duracaoMs / 1000).toInt().takeIf { it > 0 },
            episodioId = episodioAtual,
            temporada = temporadaAtual,
            numeroEp = numeroAtual,
        )
    }

    /**
     * Prepara uma fonte.
     *
     * `retomarDe` e sempre passado explicitamente para deixar claro, em cada
     * chamada, o que acontece com a posicao: troca de servidor e de qualidade
     * retomam onde estava; troca de episodio comeca do zero.
     */
    suspend fun preparar(indice: Int, retomarDe: Long) {
        val id = sessao ?: return
        val fonte = fontes.getOrNull(indice) ?: run {
            falha = "Nenhum servidor conseguiu abrir este conteúdo."
            carregando = false
            return
        }
        carregando = true
        falha = null

        val midia = FontesTv.resolver(id, fonte)
        if (midia == null) {
            // Cai para a proxima. E o mesmo failover dos outros ambientes: a
            // pessoa nao precisa saber qual servidor falhou, so continuar vendo.
            if (indice + 1 < fontes.size) {
                fonteAtual = indice + 1
                preparar(indice + 1, retomarDe)
            } else {
                falha = "Nenhum servidor conseguiu abrir este conteúdo."
                carregando = false
            }
            return
        }

        fabricaHttp.setDefaultRequestProperties(CabecalhosMidia.de(midia.referer))

        val legendas = midia.legendas.map { legenda ->
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(legenda.file))
                .setMimeType(
                    if (legenda.file.substringBefore('?').endsWith(".srt", true)) {
                        MimeTypes.APPLICATION_SUBRIP
                    } else {
                        MimeTypes.TEXT_VTT
                    },
                )
                .setLanguage("pt")
                .setLabel(legenda.label)
                .build()
        }

        val item = MediaItem.Builder()
            .setUri(midia.url)
            .setSubtitleConfigurations(legendas)
            .build()

        player.setMediaItem(item, retomarDe.coerceAtLeast(0L))
        player.prepare()
        player.playWhenReady = true
        fonteAtual = indice
        carregando = false
    }

    // Abertura: uma unica ida ao servidor para a lista de fontes, e a extracao
    // de uma so delas. As outras nao sao resolvidas ate serem necessarias.
    LaunchedEffect(pedido.conteudoId, episodioAtual) {
        carregando = true
        val abertura = FontesTv.abrir(
            pedido.copy(
                temporada = temporadaAtual,
                numeroEp = numeroAtual,
                episodioId = episodioAtual,
            ),
        )
        if (abertura == null || abertura.fontes.isEmpty()) {
            falha = "Este conteúdo não está disponível agora."
            carregando = false
            return@LaunchedEffect
        }
        sessao = abertura.sessao
        fontes = abertura.fontes
        preparar(0, posicaoMs)
    }

    DisposableEffect(Unit) {
        val ouvinte = object : Player.Listener {
            override fun onTracksChanged(tracks: Tracks) {
                faixasAudio = faixasDe(tracks, C.TRACK_TYPE_AUDIO)
                faixasTexto = faixasDe(tracks, C.TRACK_TYPE_TEXT)
                alturas = alturasDe(tracks)
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                tocando = isPlaying
            }

            override fun onPlayerError(error: PlaybackException) {
                ObaLog.alerta(
                    ObaLog.Fase.EXTRACAO, "tv_player_erro",
                    "codigo" to error.errorCodeName,
                )
                // Erro de rede ou de midia depois de comecar: tenta o proximo
                // servidor a partir de onde parou, sem perguntar nada.
                escopo.launch {
                    if (fonteAtual + 1 < fontes.size) {
                        preparar(fonteAtual + 1, posicaoMs)
                    } else {
                        falha = "A reprodução foi interrompida."
                    }
                }
            }
        }
        player.addListener(ouvinte)
        onDispose {
            salvarProgresso()
            player.removeListener(ouvinte)
            player.release()
        }
    }

    // Relogio da interface e do progresso. Um so laco para os dois: a barra
    // precisa de meio segundo, e o servidor, de meio minuto.
    LaunchedEffect(Unit) {
        var desdeSalvou = 0L
        while (true) {
            delay(500)
            if (player.duration > 0) duracaoMs = player.duration
            posicaoMs = player.currentPosition
            desdeSalvou += 500
            if (desdeSalvou >= SALVAR_A_CADA_MS) {
                desdeSalvou = 0
                if (player.isPlaying) salvarProgresso()
            }
        }
    }

    // Controles somem sozinhos. Painel aberto nao some: quem abriu esta
    // escolhendo alguma coisa e ficaria sem referencia se a tela se limpasse.
    LaunchedEffect(camada, ultimaTecla) {
        if (camada != Camada.Controles) return@LaunchedEffect
        delay(ESCONDER_MS)
        if (System.currentTimeMillis() - ultimaTecla >= ESCONDER_MS) camada = Camada.Nenhuma
    }

    // Foco no captador de teclas com insistencia: um pedido unico pode chegar
    // antes de o no estar anexado e, sem foco aqui, o D-pad nao comanda o player.
    // Refaz tambem no pulso de recuperacao (ver FocoBridge).
    LaunchedEffect(com.obaflix.tv.ui.componentes.FocoBridge.pulso) {
        repeat(12) {
            runCatching { teclado.requestFocus() }
            delay(60)
        }
    }

    // ── Acoes ────────────────────────────────────────────────────────────────

    val episodiosDaTemporada = remember(pedido.episodios, temporadaAtual) {
        pedido.episodios.filter { temporadaAtual == null || it.temporada == temporadaAtual }
    }

    fun trocarEpisodio(episodio: Episodio) {
        salvarProgresso()
        posicaoMs = 0
        temporadaAtual = episodio.temporada
        numeroAtual = episodio.numeroEp
        episodioAtual = episodio.id
        tituloAtual = pedido.titulo + "  ·  T" + episodio.temporada + " E" + episodio.numeroEp
        camada = Camada.Nenhuma
    }

    val grupos = construirGrupos(
        fontes = fontes,
        fonteAtual = fonteAtual,
        audios = faixasAudio,
        audioEscolhido = audioEscolhido,
        textos = faixasTexto,
        textoEscolhido = textoEscolhido,
        alturas = alturas,
        alturaEscolhida = alturaEscolhida,
        proporcao = proporcao,
    )

    fun aplicarOpcao(grupo: Int, opcao: Int) {
        when (grupos.getOrNull(grupo)?.tipo) {
            TipoGrupo.Servidor -> {
                if (opcao != fonteAtual) escopo.launch { preparar(opcao, posicaoMs) }
            }
            TipoGrupo.Audio -> {
                audioEscolhido = opcao
                aplicarFaixa(player, faixasAudio.getOrNull(opcao), C.TRACK_TYPE_AUDIO)
            }
            TipoGrupo.Legenda -> {
                textoEscolhido = opcao
                if (opcao == 0) {
                    desligarFaixa(player, C.TRACK_TYPE_TEXT)
                } else {
                    aplicarFaixa(player, faixasTexto.getOrNull(opcao - 1), C.TRACK_TYPE_TEXT)
                }
            }
            TipoGrupo.Qualidade -> {
                alturaEscolhida = opcao
                val altura = if (opcao == 0) Int.MAX_VALUE else alturas.getOrNull(opcao - 1) ?: Int.MAX_VALUE
                player.trackSelectionParameters = player.trackSelectionParameters
                    .buildUpon()
                    .setMaxVideoSize(Int.MAX_VALUE, altura)
                    .build()
            }
            TipoGrupo.Proporcao -> {
                proporcao = opcao
                vista.resizeMode = PROPORCOES[opcao].second
            }
            null -> Unit
        }
    }

    // ── Teclado ──────────────────────────────────────────────────────────────

    fun aoTeclar(tecla: Key): Boolean {
        ultimaTecla = System.currentTimeMillis()

        // BACK fecha uma camada por vez, de cima para baixo. So sai do player
        // quando ja nao ha nada aberto — e a regra que impede o BACK acidental
        // de tirar a pessoa do filme.
        if (tecla == Key.Back || tecla == Key.Escape) {
            when (camada) {
                Camada.Opcoes -> camada = Camada.Controles
                Camada.Episodios -> camada = Camada.Controles
                Camada.Controles -> camada = Camada.Nenhuma
                Camada.Nenhuma -> {
                    salvarProgresso()
                    Navegacao.voltar()
                }
            }
            return true
        }

        val temEpisodios = pedido.ehSerie && episodiosDaTemporada.isNotEmpty()

        when (tecla) {
            Key.DirectionCenter, Key.Enter, Key.NumPadEnter -> when (camada) {
                Camada.Nenhuma -> camada = Camada.Controles
                Camada.Controles -> {
                    if (player.isPlaying) player.pause() else player.play()
                }
                Camada.Episodios -> episodiosDaTemporada.getOrNull(epSelecionado)
                    ?.takeIf { it.disponivel }
                    ?.let { trocarEpisodio(it) }
                Camada.Opcoes -> aplicarOpcao(grupoSel, opcaoSel)
            }

            Key.DirectionDown -> camada = when (camada) {
                Camada.Nenhuma, Camada.Controles ->
                    if (temEpisodios) {
                        epSelecionado = episodiosDaTemporada
                            .indexOfFirst { it.id == episodioAtual }
                            .coerceAtLeast(0)
                        Camada.Episodios
                    } else {
                        Camada.Opcoes
                    }
                Camada.Episodios -> Camada.Opcoes
                Camada.Opcoes -> {
                    grupoSel = (grupoSel + 1).coerceAtMost(grupos.lastIndex.coerceAtLeast(0))
                    opcaoSel = grupos.getOrNull(grupoSel)?.selecionada ?: 0
                    Camada.Opcoes
                }
            }

            Key.DirectionUp -> camada = when (camada) {
                Camada.Opcoes -> if (grupoSel > 0) {
                    grupoSel -= 1
                    opcaoSel = grupos.getOrNull(grupoSel)?.selecionada ?: 0
                    Camada.Opcoes
                } else if (temEpisodios) Camada.Episodios else Camada.Controles
                Camada.Episodios -> Camada.Controles
                else -> Camada.Controles
            }

            Key.DirectionLeft -> when (camada) {
                Camada.Episodios -> epSelecionado = (epSelecionado - 1).coerceAtLeast(0)
                Camada.Opcoes -> opcaoSel = (opcaoSel - 1).coerceAtLeast(0)
                else -> {
                    camada = Camada.Controles
                    player.seekTo((player.currentPosition - SALTO_MS).coerceAtLeast(0))
                }
            }

            Key.DirectionRight -> when (camada) {
                Camada.Episodios ->
                    epSelecionado = (epSelecionado + 1).coerceAtMost(episodiosDaTemporada.lastIndex)
                Camada.Opcoes ->
                    opcaoSel = (opcaoSel + 1)
                        .coerceAtMost((grupos.getOrNull(grupoSel)?.opcoes?.lastIndex ?: 0))
                else -> {
                    camada = Camada.Controles
                    val limite = if (duracaoMs > 0) duracaoMs else Long.MAX_VALUE
                    player.seekTo((player.currentPosition + SALTO_MS).coerceAtMost(limite))
                }
            }

            Key.MediaPlayPause, Key.MediaPlay, Key.MediaPause ->
                if (player.isPlaying) player.pause() else player.play()

            Key.MediaFastForward -> player.seekForward()
            Key.MediaRewind -> player.seekBack()

            else -> return false
        }
        return true
    }

    // ── Desenho ──────────────────────────────────────────────────────────────

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(teclado)
            .focusable()
            .onPreviewKeyEvent { evento ->
                // BACK e consumido tambem na soltura. Se so o KeyDown fosse
                // consumido, o KeyUp chegaria a Activity, que dispararia o
                // voltar do sistema por cima — um toque, duas camadas fechadas.
                val ehVoltar = evento.key == Key.Back || evento.key == Key.Escape
                when {
                    evento.type == KeyEventType.KeyDown -> aoTeclar(evento.key)
                    ehVoltar -> true
                    else -> false
                }
            },
    ) {
        AndroidView(factory = { vista }, modifier = Modifier.fillMaxSize())

        // Enquanto a primeira fonte nao abre, a arte do conteudo segura a tela.
        // Preto puro com um texto no meio parece travamento; a capa do que se
        // vai assistir parece o filme comecando.
        if (carregando || falha != null) {
            Box(Modifier.fillMaxSize()) {
                ApiObaflix.imagem(pedido.backdrop, "w1280")?.let {
                    AsyncImage(
                        model = it,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.72f)))
                Column(
                    modifier = Modifier.align(Alignment.Center),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        text = falha ?: "Preparando a reprodução…",
                        color = if (falha != null) Cores.Falha else Cores.Texto,
                        fontSize = Escala.Corpo,
                    )
                    EspacoV(8.dp)
                    Text(
                        text = tituloAtual,
                        color = Cores.TextoFraco,
                        fontSize = Escala.Rotulo,
                    )
                }
            }
        }

        AnimatedVisibility(
            visible = camada != Camada.Nenhuma,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.fillMaxSize(),
        ) {
            Box(
                Modifier.fillMaxSize().background(
                    Brush.verticalGradient(
                        0f to Color.Black.copy(alpha = 0.85f),
                        0.35f to Color.Transparent,
                        0.6f to Color.Black.copy(alpha = 0.6f),
                        1f to Color.Black.copy(alpha = 0.95f),
                    ),
                ),
            )
        }

        AnimatedVisibility(
            visible = camada != Camada.Nenhuma,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.TopStart),
        ) {
            Cabecalho(tituloAtual, fontes.getOrNull(fonteAtual)?.descricao)
        }

        Column(
            modifier = Modifier.align(Alignment.BottomStart).fillMaxWidth(),
        ) {
            AnimatedVisibility(
                visible = camada == Camada.Opcoes,
                enter = slideInVertically { it } + fadeIn(),
                exit = slideOutVertically { it } + fadeOut(),
            ) {
                PainelOpcoes(grupos, grupoSel, opcaoSel)
            }

            AnimatedVisibility(
                visible = camada == Camada.Episodios,
                enter = slideInVertically { it } + fadeIn(),
                exit = slideOutVertically { it } + fadeOut(),
            ) {
                FaixaEpisodios(episodiosDaTemporada, epSelecionado, episodioAtual)
            }

            AnimatedVisibility(
                visible = camada != Camada.Nenhuma,
                enter = fadeIn(),
                exit = fadeOut(),
            ) {
                BarraTempo(
                    posicaoMs = posicaoMs,
                    duracaoMs = duracaoMs,
                    tocando = tocando,
                    naTimeline = camada == Camada.Controles,
                    dica = dicaDaCamada(camada, pedido.ehSerie),
                )
            }
        }
    }
}

// ── Faixas do ExoPlayer ──────────────────────────────────────────────────────

/** Uma faixa selecionavel, ja com o rotulo que o usuario le. */
private data class Faixa(
    val rotulo: String,
    val grupo: Tracks.Group,
    val indice: Int,
)

private fun faixasDe(tracks: Tracks, tipo: Int): List<Faixa> =
    tracks.groups.filter { it.type == tipo }.flatMap { grupo ->
        (0 until grupo.length).mapNotNull { i ->
            if (!grupo.isTrackSupported(i)) return@mapNotNull null
            val formato = grupo.getTrackFormat(i)
            val nome = formato.label
                ?: formato.language?.let { idioma(it) }
                ?: ("Faixa " + (i + 1))
            Faixa(nome, grupo, i)
        }
    }

private fun idioma(codigo: String): String = when (codigo.lowercase().take(2)) {
    "pt" -> "Português"
    "en" -> "Inglês"
    "es" -> "Espanhol"
    "ja" -> "Japonês"
    else -> codigo.uppercase()
}

private fun alturasDe(tracks: Tracks): List<Int> =
    tracks.groups.filter { it.type == C.TRACK_TYPE_VIDEO }
        .flatMap { grupo -> (0 until grupo.length).map { grupo.getTrackFormat(it).height } }
        .filter { it > 0 }
        .distinct()
        .sortedDescending()

private fun aplicarFaixa(player: ExoPlayer, faixa: Faixa?, tipo: Int) {
    if (faixa == null) return
    player.trackSelectionParameters = player.trackSelectionParameters
        .buildUpon()
        .setTrackTypeDisabled(tipo, false)
        .setOverrideForType(TrackSelectionOverride(faixa.grupo.mediaTrackGroup, faixa.indice))
        .build()
}

private fun desligarFaixa(player: ExoPlayer, tipo: Int) {
    player.trackSelectionParameters = player.trackSelectionParameters
        .buildUpon()
        .setTrackTypeDisabled(tipo, true)
        .build()
}

// ── Painel de opcoes ─────────────────────────────────────────────────────────

private enum class TipoGrupo { Audio, Legenda, Qualidade, Proporcao, Servidor }

private data class GrupoOpcao(
    val tipo: TipoGrupo,
    val titulo: String,
    val opcoes: List<String>,
    val selecionada: Int,
)

/**
 * Monta o painel com o que **existe** nesta reproducao.
 *
 * Grupo sem opcao real nao entra: um seletor de idioma com uma unica faixa, ou
 * de qualidade num MP4 de fluxo unico, so ensina a pessoa que mexer ali nao
 * adianta nada.
 */
private fun construirGrupos(
    fontes: List<Fonte>,
    fonteAtual: Int,
    audios: List<Faixa>,
    audioEscolhido: Int,
    textos: List<Faixa>,
    textoEscolhido: Int,
    alturas: List<Int>,
    alturaEscolhida: Int,
    proporcao: Int,
): List<GrupoOpcao> = buildList {
    if (audios.size > 1) {
        add(GrupoOpcao(TipoGrupo.Audio, "Áudio", audios.map { it.rotulo }, audioEscolhido))
    }
    if (textos.isNotEmpty()) {
        add(
            GrupoOpcao(
                TipoGrupo.Legenda,
                "Legenda",
                listOf("Desligada") + textos.map { it.rotulo },
                textoEscolhido,
            ),
        )
    }
    if (alturas.size > 1) {
        add(
            GrupoOpcao(
                TipoGrupo.Qualidade,
                "Qualidade",
                listOf("Automática") + alturas.map { it.toString() + "p" },
                alturaEscolhida,
            ),
        )
    }
    add(GrupoOpcao(TipoGrupo.Proporcao, "Tela", PROPORCOES.map { it.first }, proporcao))
    if (fontes.size > 1) {
        add(GrupoOpcao(TipoGrupo.Servidor, "Servidor", fontes.map { it.descricao }, fonteAtual))
    }
}

@Composable
private fun PainelOpcoes(grupos: List<GrupoOpcao>, grupoSel: Int, opcaoSel: Int) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = margemHorizontal(), vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        grupos.forEachIndexed { indiceGrupo, grupo ->
            val ativo = indiceGrupo == grupoSel
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = grupo.titulo,
                    color = if (ativo) Cores.Texto else Cores.TextoApagado,
                    fontSize = Escala.Rotulo,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.width(120.dp),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    grupo.opcoes.forEachIndexed { indiceOpcao, rotulo ->
                        val destacado = ativo && indiceOpcao == opcaoSel
                        val escolhido = indiceOpcao == grupo.selecionada
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(50))
                                .background(
                                    when {
                                        destacado -> Cores.FocoHalo
                                        escolhido -> Cores.Destaque
                                        else -> Color.White.copy(alpha = 0.12f)
                                    },
                                )
                                .padding(horizontal = 18.dp, vertical = 8.dp),
                        ) {
                            Text(
                                text = rotulo,
                                color = if (destacado) Color(0xFF101014) else Cores.Texto,
                                fontSize = Escala.Miudo,
                                fontWeight = if (escolhido) FontWeight.Bold else FontWeight.Normal,
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
        }
    }
}

// ── Faixa de episodios ───────────────────────────────────────────────────────

@Composable
private fun FaixaEpisodios(
    episodios: List<Episodio>,
    selecionado: Int,
    emReproducao: String?,
) {
    val rolagem = rememberLazyListState()
    LaunchedEffect(selecionado) {
        runCatching { rolagem.animateScrollToItem(selecionado.coerceAtLeast(0)) }
    }

    Column(Modifier.padding(bottom = 10.dp)) {
        Text(
            text = "Episódios",
            color = Cores.Texto,
            fontSize = Escala.Rotulo,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = margemHorizontal(), bottom = 8.dp),
        )
        LazyRow(
            state = rolagem,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                horizontal = margemHorizontal(),
            ),
        ) {
            itemsIndexed(episodios, key = { _, ep -> ep.id }) { indice, episodio ->
                val destacado = indice == selecionado
                Column(
                    modifier = Modifier
                        .width(206.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (destacado) Color.White.copy(alpha = 0.14f) else Color.Transparent)
                        .border(
                            width = if (destacado) 3.dp else 0.dp,
                            color = if (destacado) Cores.FocoHalo else Color.Transparent,
                            shape = RoundedCornerShape(8.dp),
                        )
                        .padding(8.dp),
                ) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(104.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(Cores.Superficie),
                    ) {
                        ApiObaflix.imagem(episodio.thumbnail, "w300")?.let {
                            AsyncImage(
                                model = it,
                                contentDescription = episodio.rotulo,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                        if (episodio.id == emReproducao) {
                            Box(
                                Modifier
                                    .align(Alignment.BottomStart)
                                    .padding(6.dp)
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(Cores.Destaque)
                                    .padding(horizontal = 6.dp, vertical = 2.dp),
                            ) {
                                Text(
                                    text = "no ar",
                                    color = Cores.Texto,
                                    fontSize = Escala.Miudo,
                                    fontWeight = FontWeight.Bold,
                                )
                            }
                        }
                    }
                    EspacoV(6.dp)
                    Text(
                        text = "E" + episodio.numeroEp + " · " + episodio.rotulo,
                        color = if (destacado) Cores.Texto else Cores.TextoFraco,
                        fontSize = Escala.Miudo,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

// ── Barra de tempo e cabecalho ───────────────────────────────────────────────

@Composable
private fun BarraTempo(
    posicaoMs: Long,
    duracaoMs: Long,
    tocando: Boolean,
    naTimeline: Boolean,
    dica: String,
) {
    val fracao = if (duracaoMs > 0) (posicaoMs.toFloat() / duracaoMs).coerceIn(0f, 1f) else 0f

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = margemHorizontal(), vertical = 16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(34.dp)
                    .clip(RoundedCornerShape(50))
                    .background(if (naTimeline) Cores.FocoHalo else Color.White.copy(alpha = 0.18f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (tocando) "II" else "▶",
                    color = if (naTimeline) Color(0xFF101014) else Cores.Texto,
                    fontSize = Escala.Miudo,
                    fontWeight = FontWeight.Black,
                )
            }
            EspacoH(14.dp)
            Text(text = tempo(posicaoMs), color = Cores.Texto, fontSize = Escala.Rotulo)
            EspacoH(12.dp)

            Box(
                Modifier
                    .weight(1f)
                    .height(if (naTimeline) 8.dp else 5.dp)
                    .clip(RoundedCornerShape(50))
                    .background(Color.White.copy(alpha = 0.22f)),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth(fracao)
                        .fillMaxHeight()
                        .clip(RoundedCornerShape(50))
                        .background(Cores.Destaque),
                )
            }

            EspacoH(12.dp)
            Text(text = tempo(duracaoMs), color = Cores.TextoFraco, fontSize = Escala.Rotulo)
        }
        EspacoV(8.dp)
        Text(text = dica, color = Cores.TextoApagado, fontSize = Escala.Miudo)
    }
}

@Composable
private fun Cabecalho(titulo: String, servidor: String?) {
    Column(Modifier.padding(horizontal = margemHorizontal(), vertical = 24.dp)) {
        Text(
            text = titulo,
            color = Cores.Texto,
            fontSize = Escala.Titulo,
            fontWeight = FontWeight.Black,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (servidor != null) {
            EspacoV(4.dp)
            Text(text = servidor, color = Cores.TextoFraco, fontSize = Escala.Rotulo)
        }
    }
}

/** O que cada camada permite fazer agora. Some quando a interface some. */
private fun dicaDaCamada(camada: Camada, ehSerie: Boolean): String = when (camada) {
    Camada.Controles ->
        if (ehSerie) "◀ ▶ avança 10s   ·   ▼ episódios e opções   ·   OK pausa"
        else "◀ ▶ avança 10s   ·   ▼ opções   ·   OK pausa"
    Camada.Episodios -> "◀ ▶ escolhe o episódio   ·   OK assiste   ·   ▼ opções"
    Camada.Opcoes -> "◀ ▶ escolhe   ·   ▲ ▼ troca de linha   ·   OK aplica"
    Camada.Nenhuma -> ""
}

private fun tempo(ms: Long): String {
    if (ms <= 0) return "0:00"
    val total = ms / 1000
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) {
        String.format("%d:%02d:%02d", h, m, s)
    } else {
        String.format("%d:%02d", m, s)
    }
}
