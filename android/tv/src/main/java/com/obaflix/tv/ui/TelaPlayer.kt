package com.obaflix.tv.ui

import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.tv.material3.Text
import com.obaflix.ObaflixApp
import com.obaflix.bridge.ExtractResult
import com.obaflix.bridge.ObaLog
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.player.FontesTv
import com.obaflix.tv.sessao.SessaoTv
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope

/**
 * Player de televisão.
 *
 * Tudo pelo controle, e nada escondido atrás de gesto:
 *
 *   CIMA / BAIXO   revelam os controles; com o painel aberto, andam nele
 *   ESQ / DIR      retrocedem e avançam 10 s; com o painel aberto, trocam opção
 *   OK             play/pause; no painel, confirma
 *   VOLTAR         fecha o painel; sem painel, fecha os controles; depois sai
 *   MENU           abre o painel direto
 *
 * A regra do VOLTAR é a que mais importa: sair do player por engano no meio de
 * um episódio é o erro mais irritante que uma TV comete, então ele sempre fecha
 * alguma coisa antes de sair.
 */

private const val PASSO_SEEK_MS = 10_000L
private const val OCULTAR_APOS_MS = 4_000L
private const val INTERVALO_PROGRESSO_MS = 30_000L

private enum class Painel { NENHUM, SERVIDOR, LEGENDA, PROPORCAO }

@OptIn(UnstableApi::class)
@Composable
fun TelaPlayer(
    rota: Rota.Player,
    aoFechar: () -> Unit,
    aoTrocarEpisodio: (Rota.Player) -> Unit,
) {
    val context = LocalContext.current
    val escopo = rememberCoroutineScope()

    var sessao by remember(rota) { mutableStateOf<FontesTv.SessaoFontes?>(null) }
    var indiceFonte by remember(rota) { mutableStateOf(0) }
    var extracao by remember(rota) { mutableStateOf<ExtractResult?>(null) }
    var mensagem by remember(rota) { mutableStateOf<String?>(null) }
    var carregando by remember(rota) { mutableStateOf(true) }

    var controlesVisiveis by remember { mutableStateOf(true) }
    var painel by remember { mutableStateOf(Painel.NENHUM) }
    var tocando by remember { mutableStateOf(true) }
    var posicaoMs by remember { mutableStateOf(0L) }
    var duracaoMs by remember { mutableStateOf(0L) }
    var proporcao by remember { mutableStateOf(AspectRatioFrameLayout.RESIZE_MODE_FIT) }
    var episodios by remember(rota.conteudoId) { mutableStateOf<List<ApiObaflix.Episodio>>(emptyList()) }

    val foco = remember { androidx.compose.ui.focus.FocusRequester() }

    // ── Player ───────────────────────────────────────────────────────────────

    val player = remember {
        ExoPlayer.Builder(context).build().apply {
            addListener(object : Player.Listener {
                override fun onIsPlayingChanged(estaTocando: Boolean) { tocando = estaTocando }
                override fun onPlayerError(erro: PlaybackException) {
                    ObaLog.alerta(ObaLog.Fase.PLAYER, "erro_reproducao", "codigo" to erro.errorCodeName)
                    // Falhou: tenta a próxima fonte a partir da posição atual.
                    // Voltar ao início aqui seria punir quem já assistiu meia hora.
                    indiceFonte += 1
                }
            })
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            escopo.launch {
                FontesTv.salvarProgresso(
                    rota.conteudoId, rota.tipo, rota.episodioId, rota.temporada, rota.numeroEp,
                    (player.currentPosition / 1000).toInt(),
                    (player.duration / 1000).toInt().takeIf { it > 0 },
                )
            }
            player.release()
        }
    }

    // ── Fontes ───────────────────────────────────────────────────────────────

    LaunchedEffect(rota) {
        carregando = true
        mensagem = null
        sessao = FontesTv.abrir(rota.conteudoId, rota.tipo, rota.temporada, rota.numeroEp)
        if (sessao == null || sessao?.fontes.orEmpty().none { it.resolvivel }) {
            mensagem = "Nenhum servidor disponível para este título."
            carregando = false
        }
        if (rota.tipo != "filme" && episodios.isEmpty()) {
            episodios = ApiObaflix.episodios(rota.conteudoId)
        }
    }

    // Tenta a fonte da vez; se ela não resolve, passa para a seguinte.
    LaunchedEffect(sessao, indiceFonte) {
        val s = sessao ?: return@LaunchedEffect
        val candidatas = s.fontes.filter { it.resolvivel }
        if (indiceFonte >= candidatas.size) {
            mensagem = "Não foi possível reproduzir. Tente outro título."
            carregando = false
            return@LaunchedEffect
        }
        carregando = true
        // Posição atual, não a inicial: numa troca de servidor no meio do filme
        // é daqui que a reprodução tem de continuar.
        val retomarMs = if (player.currentPosition > 0) player.currentPosition
        else FontesTv.progressoSalvo(rota.conteudoId, rota.episodioId) * 1000L

        val resultado = FontesTv.resolver(s.sessao, candidatas[indiceFonte].id)
        if (resultado == null) {
            indiceFonte += 1
            return@LaunchedEffect
        }
        extracao = resultado
        tocar(player, resultado, retomarMs)
        carregando = false
    }

    // ── Relógio e progresso ──────────────────────────────────────────────────

    LaunchedEffect(Unit) {
        while (true) {
            posicaoMs = player.currentPosition
            duracaoMs = player.duration.coerceAtLeast(0L)
            delay(500)
        }
    }

    LaunchedEffect(rota) {
        // A cada 30 s, não a cada segundo: o suficiente para retomar sem perder
        // nada perceptível, e 120× menos requisição do que gravar sempre.
        while (true) {
            delay(INTERVALO_PROGRESSO_MS)
            if (player.isPlaying) {
                FontesTv.salvarProgresso(
                    rota.conteudoId, rota.tipo, rota.episodioId, rota.temporada, rota.numeroEp,
                    (player.currentPosition / 1000).toInt(),
                    (player.duration / 1000).toInt().takeIf { it > 0 },
                )
            }
        }
    }

    LaunchedEffect(controlesVisiveis, painel, tocando) {
        if (controlesVisiveis && painel == Painel.NENHUM && tocando) {
            delay(OCULTAR_APOS_MS)
            controlesVisiveis = false
        }
    }

    LaunchedEffect(Unit) { runCatching { foco.requestFocus() } }

    // ── Teclas ───────────────────────────────────────────────────────────────

    BackHandler {
        when {
            painel != Painel.NENHUM -> painel = Painel.NENHUM
            controlesVisiveis -> controlesVisiveis = false
            else -> aoFechar()
        }
    }

    fun mostrarControles() { controlesVisiveis = true }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .focusRequester(foco)
            // Focável para receber as teclas; sem halo, porque o player é a
            // superfície inteira e não um botão.
            .focusable()
            .onKeyEvent { evento ->
                if (evento.type != KeyEventType.KeyUp) return@onKeyEvent false
                // Com o painel aberto, as setas pertencem a ele.
                if (painel != Painel.NENHUM) return@onKeyEvent false
                when (evento.key) {
                    Key.DirectionLeft -> {
                        player.seekTo((player.currentPosition - PASSO_SEEK_MS).coerceAtLeast(0))
                        mostrarControles(); true
                    }
                    Key.DirectionRight -> {
                        player.seekTo(player.currentPosition + PASSO_SEEK_MS)
                        mostrarControles(); true
                    }
                    Key.MediaRewind -> {
                        player.seekTo((player.currentPosition - 30_000L).coerceAtLeast(0))
                        mostrarControles(); true
                    }
                    Key.MediaFastForward -> {
                        player.seekTo(player.currentPosition + 30_000L); mostrarControles(); true
                    }
                    Key.DirectionUp, Key.DirectionDown -> { mostrarControles(); true }
                    Key.DirectionCenter, Key.Enter, Key.MediaPlayPause -> {
                        if (player.isPlaying) player.pause() else player.play()
                        mostrarControles(); true
                    }
                    Key.Menu -> { painel = Painel.SERVIDOR; controlesVisiveis = true; true }
                    else -> false
                }
            },
    ) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                    this.player = player
                }
            },
            update = { it.resizeMode = proporcao },
            modifier = Modifier.fillMaxSize(),
        )

        if (carregando) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    text = "Carregando ${sessao?.fontes?.filter { it.resolvivel }?.getOrNull(indiceFonte)?.rotulo ?: ""}…",
                    color = Cores.Texto,
                    fontSize = Escala.Corpo,
                )
            }
        }

        mensagem?.let {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(text = it, color = Cores.Alerta, fontSize = Escala.Corpo)
            }
        }

        if (controlesVisiveis && painel == Painel.NENHUM) {
            Controles(
                titulo = rota.titulo,
                subtitulo = rota.temporada?.let { t -> "T$t:E${rota.numeroEp}" },
                posicaoMs = posicaoMs,
                duracaoMs = duracaoMs,
                tocando = tocando,
            )
        }

        if (painel != Painel.NENHUM) {
            PainelOpcoes(
                painel = painel,
                fontes = sessao?.fontes.orEmpty().filter { it.resolvivel },
                fonteAtual = indiceFonte,
                extracao = extracao,
                episodios = episodios.filter { it.temporada == rota.temporada },
                episodioAtual = rota.numeroEp,
                aoTrocarPainel = { painel = it },
                aoEscolherFonte = { novo ->
                    // A posição vem do player no instante da troca — é isso que
                    // faz mudar de servidor não custar o que já foi assistido.
                    indiceFonte = novo
                    painel = Painel.NENHUM
                },
                aoEscolherProporcao = {
                    proporcao = it
                    painel = Painel.NENHUM
                },
                aoEscolherEpisodio = { ep ->
                    painel = Painel.NENHUM
                    aoTrocarEpisodio(
                        rota.copy(
                            temporada = ep.temporada,
                            numeroEp = ep.numeroEp,
                            episodioId = ep.id,
                            inicioSeg = 0,
                        ),
                    )
                },
                aoFechar = { painel = Painel.NENHUM },
            )
        }
    }
}

@OptIn(UnstableApi::class)
private fun tocar(player: ExoPlayer, resultado: ExtractResult, retomarMs: Long) {
    // O mesmo OkHttp da extração, com o Referer que o provedor exige. Sem ele o
    // CDN devolve 403 e o vídeo simplesmente não abre.
    val cabecalhos = buildMap<String, String> {
        resultado.referer?.let { referer -> put("Referer", referer) }
        SessaoTv.uaNavegador?.let { ua -> put("User-Agent", ua) }
    }
    val fabrica = OkHttpDataSource.Factory(ObaflixApp.mediaClient)
        .setDefaultRequestProperties(cabecalhos)

    val mediaItem = MediaItem.Builder()
        .setUri(resultado.stream)
        .setSubtitleConfigurations(
            resultado.subtitles.mapIndexed { indice, faixa ->
                MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse(faixa.file))
                    .setMimeType(if (faixa.file.contains(".srt")) MimeTypes.APPLICATION_SUBRIP else MimeTypes.TEXT_VTT)
                    .setLanguage("pt")
                    .setLabel(faixa.label)
                    .setSelectionFlags(if (indice == 0) androidx.media3.common.C.SELECTION_FLAG_DEFAULT else 0)
                    .build()
            },
        )
        .build()

    val fonte = if (resultado.tipo == "hls" || resultado.stream.contains(".m3u8")) {
        HlsMediaSource.Factory(fabrica).createMediaSource(mediaItem)
    } else {
        ProgressiveMediaSource.Factory(fabrica).createMediaSource(mediaItem)
    }

    player.setMediaSource(fonte)
    player.prepare()
    if (retomarMs > 0) player.seekTo(retomarMs)
    player.playWhenReady = true
}

private fun tempo(ms: Long): String {
    if (ms <= 0) return "0:00"
    val s = ms / 1000
    val h = s / 3600
    val m = (s % 3600) / 60
    val seg = s % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, seg) else "%d:%02d".format(m, seg)
}

@Composable
private fun Controles(
    titulo: String,
    subtitulo: String?,
    posicaoMs: Long,
    duracaoMs: Long,
    tocando: Boolean,
) {
    Box(Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .fillMaxWidth()
                .background(
                    Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.9f))),
                )
                .padding(horizontal = 56.dp, vertical = 36.dp),
        ) {
            Text(text = titulo, color = Cores.Texto, fontSize = Escala.Secao, fontWeight = FontWeight.Bold)
            subtitulo?.let {
                Text(text = it, color = Cores.TextoFraco, fontSize = Escala.Rotulo)
            }

            Box(Modifier.height(16.dp))

            // Barra grossa: a três metros, uma linha fina não comunica posição.
            Box(
                Modifier.fillMaxWidth().height(6.dp)
                    .clip(RoundedCornerShape(3.dp))
                    .background(Color.White.copy(alpha = 0.25f)),
            ) {
                val fracao = if (duracaoMs > 0) (posicaoMs.toFloat() / duracaoMs).coerceIn(0f, 1f) else 0f
                Box(Modifier.fillMaxWidth(fracao).fillMaxHeight().background(Cores.Destaque))
            }

            Box(Modifier.height(10.dp))

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(
                    text = "${tempo(posicaoMs)} / ${tempo(duracaoMs)}",
                    color = Cores.TextoFraco,
                    fontSize = Escala.Rotulo,
                )
                Text(
                    text = if (tocando) "OK pausa  ·  ← → 10s  ·  MENU opções" else "Pausado  ·  OK retoma",
                    color = Cores.TextoFraco,
                    fontSize = Escala.Rotulo,
                )
            }
        }
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun PainelOpcoes(
    painel: Painel,
    fontes: List<FontesTv.Fonte>,
    fonteAtual: Int,
    extracao: ExtractResult?,
    episodios: List<ApiObaflix.Episodio>,
    episodioAtual: Int?,
    aoTrocarPainel: (Painel) -> Unit,
    aoEscolherFonte: (Int) -> Unit,
    aoEscolherProporcao: (Int) -> Unit,
    aoEscolherEpisodio: (ApiObaflix.Episodio) -> Unit,
    aoFechar: () -> Unit,
) {
    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.86f)),
        contentAlignment = Alignment.BottomStart,
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(48.dp)) {
            // Abas do painel. Servidor primeiro porque é a opção que resolve o
            // problema mais comum: a fonte da vez não está reproduzindo bem.
            Row(
                modifier = Modifier.focusGroup(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                BotaoTv("Servidor", destaque = painel == Painel.SERVIDOR) { aoTrocarPainel(Painel.SERVIDOR) }
                BotaoTv("Legenda", destaque = painel == Painel.LEGENDA) { aoTrocarPainel(Painel.LEGENDA) }
                BotaoTv("Proporção", destaque = painel == Painel.PROPORCAO) { aoTrocarPainel(Painel.PROPORCAO) }
                if (episodios.isNotEmpty()) {
                    BotaoTv("Episódios") { aoTrocarPainel(Painel.NENHUM) }
                }
                BotaoTv("Fechar") { aoFechar() }
            }

            Box(Modifier.height(22.dp))

            when (painel) {
                Painel.SERVIDOR -> LazyRow(
                    modifier = Modifier.focusGroup(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    contentPadding = PaddingValues(end = 64.dp),
                ) {
                    // Só o rótulo genérico. O provedor real nunca chega aqui.
                    items(fontes.indices.toList(), key = { it }) { indice ->
                        val f = fontes[indice]
                        BotaoTv(
                            texto = f.rotulo + (f.idioma?.let { " · ${if (it == "dub") "Dublado" else "Legendado"}" } ?: "") +
                                if (indice == fonteAtual) "  ✓" else "",
                            destaque = indice == fonteAtual,
                        ) { aoEscolherFonte(indice) }
                    }
                }

                Painel.LEGENDA -> {
                    val faixas = extracao?.subtitles.orEmpty()
                    if (faixas.isEmpty()) {
                        Text("Este servidor não trouxe legendas.", color = Cores.TextoFraco, fontSize = Escala.Corpo)
                    } else {
                        LazyRow(
                            modifier = Modifier.focusGroup(),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            items(faixas, key = { it.file }) { faixa ->
                                BotaoTv(faixa.label) { aoFechar() }
                            }
                        }
                    }
                }

                Painel.PROPORCAO -> Row(
                    modifier = Modifier.focusGroup(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    BotaoTv("Ajustar") { aoEscolherProporcao(AspectRatioFrameLayout.RESIZE_MODE_FIT) }
                    BotaoTv("Preencher") { aoEscolherProporcao(AspectRatioFrameLayout.RESIZE_MODE_ZOOM) }
                    BotaoTv("Esticar") { aoEscolherProporcao(AspectRatioFrameLayout.RESIZE_MODE_FILL) }
                }

                Painel.NENHUM -> if (episodios.isNotEmpty()) {
                    LazyRow(
                        modifier = Modifier.focusGroup(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        contentPadding = PaddingValues(end = 64.dp),
                    ) {
                        items(episodios, key = { it.id }) { ep ->
                            BotaoTv(
                                texto = "E${ep.numeroEp}" + if (ep.numeroEp == episodioAtual) "  ✓" else "",
                                destaque = ep.numeroEp == episodioAtual,
                            ) { aoEscolherEpisodio(ep) }
                        }
                    }
                }
            }
        }
    }
}
