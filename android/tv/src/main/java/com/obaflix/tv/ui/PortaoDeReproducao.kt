@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package com.obaflix.tv.ui

import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
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
import com.obaflix.tv.navegacao.Camada
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.player.AcaoDaEscolha
import com.obaflix.tv.player.EtapaDaReproducao
import com.obaflix.tv.player.FOCO_INICIAL_DA_ESCOLHA
import com.obaflix.tv.player.EventoDaReproducao
import com.obaflix.tv.player.MotivoDaFalha
import com.obaflix.tv.player.Pedido
import com.obaflix.tv.player.acaoDoOk
import com.obaflix.tv.player.avancar
import com.obaflix.tv.player.etapaInicial
import com.obaflix.tv.player.terminouDeVerdade
import com.obaflix.tv.sessao.SessaoTv
import com.obaflix.tv.ui.componentes.BotaoTv
import com.obaflix.tv.ui.componentes.EspacoV
import kotlinx.coroutines.delay

/**
 * A porta do player: autoriza antes de abrir, e conduz a promocao quando o
 * servidor pede.
 *
 * ## Onde as regras moram
 *
 * Em `AutorizacaoTv.kt`, puras e testadas: o mapeamento das respostas e a
 * maquina de etapas. Esta tela so faz tres coisas — chama a rota de cada etapa,
 * desenha a etapa e traduz tecla e evento de player em `EventoDaReproducao`.
 *
 * ## Com a monetizacao desligada
 *
 * `/api/playback/authorize` responde `PERMITIDO` sem credencial, a etapa vira
 * `Liberada` na primeira resposta, e o player abre exatamente como antes. O
 * custo e uma requisicao curta a mais por reproducao, que nao consulta banco
 * nem Redis com a flag desligada.
 *
 * ## Assinante
 *
 * Mesma coisa: `PERMITIDO` por direito, sem promocao. A TV nao sabe o nome do
 * plano e nao precisa: quem decide e o servidor.
 *
 * ## Conta gratuita
 *
 * Todo inicio de filme ou episodio recebe `PROMOCAO_TV_NECESSARIA`, e o video
 * abre direto. No fim, a escolha final: um plano abre os planos (sem concluir
 * nada); "Continuar gratis" pede a conclusao, e so a concessao do servidor abre
 * o player.
 */
@Composable
fun PortaoDeReproducao(camada: Camada.Player) {
    val pedido = camada.pedido
    var etapa by remember {
        mutableStateOf(etapaInicial(camada.autorizacaoPrevia, camada.memoria.escolhaPendente))
    }

    fun enviar(evento: EventoDaReproducao) {
        etapa = avancar(etapa, evento)
    }

    // Cada etapa de espera chama a sua rota. Trocar de etapa cancela a chamada
    // anterior, e uma resposta atrasada que ainda chegasse cairia em `avancar`,
    // que ignora evento fora da etapa certa.
    LaunchedEffect(etapa) {
        when (val atual = etapa) {
            is EtapaDaReproducao.Autorizando ->
                enviar(EventoDaReproducao.Decidiu(ApiObaflix.autorizarReproducao(pedido)))

            is EtapaDaReproducao.IniciandoPromocao ->
                enviar(EventoDaReproducao.PromocaoIniciou(ApiObaflix.iniciarPromocao(atual.desafioId)))

            // Unico ponto que pede a conclusao: so se chega aqui por "Continuar
            // gratis" na escolha final, que so nasce do fim real do player.
            is EtapaDaReproducao.ConcluindoPromocao ->
                enviar(EventoDaReproducao.PromocaoConcluiu(ApiObaflix.concluirPromocao(atual.desafioId)))

            is EtapaDaReproducao.Saiu ->
                if (Navegacao.pilha.lastOrNull() === camada) Navegacao.voltar()

            else -> Unit
        }
    }

    // Liberada: o BACK e do player do conteudo, que tem as proprias camadas.
    BackHandler(enabled = etapa !is EtapaDaReproducao.Liberada) {
        enviar(EventoDaReproducao.Voltou)
    }

    val verPlanos = { Navegacao.abrirPlanos() }
    val voltar = { enviar(EventoDaReproducao.Voltou) }

    when (val atual = etapa) {
        is EtapaDaReproducao.Liberada -> TelaPlayer(pedido, credencialInicial = atual.credencial)

        // Um ramo so para as duas etapas: o `PlayerPromocional` fica no mesmo
        // ponto da composicao quando o video termina, e o player nao e recriado
        // — o ultimo quadro continua na tela por baixo da escolha.
        is EtapaDaReproducao.Promocao, is EtapaDaReproducao.EscolhaFinal -> {
            val escolha = atual as? EtapaDaReproducao.EscolhaFinal
            val videoUrl = (atual as? EtapaDaReproducao.Promocao)?.videoUrl ?: escolha?.videoUrl
            Box(Modifier.fillMaxSize().background(Color.Black)) {
                if (videoUrl != null) {
                    PlayerPromocional(
                        videoUrl = videoUrl,
                        emExibicao = escolha == null,
                        aoTerminar = { enviar(EventoDaReproducao.VideoTerminou) },
                        aoFalhar = { enviar(EventoDaReproducao.VideoFalhou) },
                    )
                }
                if (escolha != null) {
                    EscolhaFinalDoAnuncio(
                        focoInicial = camada.memoria.planoEscolhido ?: FOCO_INICIAL_DA_ESCOLHA,
                        aoEscolher = { alvo ->
                            when (val acao = acaoDoOk(alvo)) {
                                // Abrir os planos nao envia evento: a etapa fica
                                // na escolha, sem conclusao e sem liberacao.
                                is AcaoDaEscolha.AbrirPlanos -> {
                                    camada.memoria.escolhaPendente = escolha.desafioId
                                    camada.memoria.planoEscolhido = alvo
                                    Navegacao.abrirPlanos(acao.indiceDoPlano)
                                }
                                AcaoDaEscolha.ContinuarGratis -> {
                                    camada.memoria.escolhaPendente = null
                                    camada.memoria.planoEscolhido = null
                                    enviar(EventoDaReproducao.EscolheuContinuarGratis)
                                }
                            }
                        },
                    )
                }
            }
        }

        is EtapaDaReproducao.Autorizando -> Espera(pedido, "Preparando a reprodução…")
        is EtapaDaReproducao.IniciandoPromocao -> Espera(pedido, "Carregando o vídeo…")
        is EtapaDaReproducao.ConcluindoPromocao -> Espera(pedido, "Liberando seu conteúdo…")
        is EtapaDaReproducao.Saiu -> Espera(pedido, "")

        is EtapaDaReproducao.Falha -> {
            val (titulo, detalhe) = when (atual.motivo) {
                MotivoDaFalha.Rede ->
                    "Não foi possível falar com o Obaflix" to "Verifique a conexão e tente de novo."
                MotivoDaFalha.VideoNaoCarregou ->
                    "O vídeo não carregou" to "Tente de novo para continuar gratuitamente."
                MotivoDaFalha.ConclusaoNaoConfirmada ->
                    "Não foi possível confirmar o vídeo" to "Tente de novo para liberar a reprodução."
            }
            AvisoDoPortao(
                pedido = pedido,
                titulo = titulo,
                detalhe = detalhe,
                acoes = buildList {
                    if (atual.retomar != null) add("Tentar de novo" to { enviar(EventoDaReproducao.TentouDeNovo) })
                    add("Voltar" to voltar)
                },
            )
        }

        is EtapaDaReproducao.ForaDoPlano -> AvisoDoPortao(
            pedido = pedido,
            titulo = "Este conteúdo não faz parte do seu plano",
            detalhe = "Veja os planos disponíveis para assistir.",
            acoes = listOf(ROTULO_VER_PLANOS to verPlanos, "Voltar" to voltar),
        )

        is EtapaDaReproducao.GratuitoIndisponivel -> AvisoDoPortao(
            pedido = pedido,
            titulo = "Reprodução gratuita indisponível agora",
            detalhe = "Tente de novo mais tarde ou veja os planos para assistir sem anúncios.",
            acoes = listOf(ROTULO_VER_PLANOS to verPlanos, "Voltar" to voltar),
        )

        is EtapaDaReproducao.ConteudoInexistente -> AvisoDoPortao(
            pedido = pedido,
            titulo = "Este conteúdo não está disponível agora.",
            detalhe = "",
            acoes = listOf("Voltar" to voltar),
        )

        is EtapaDaReproducao.SemSessao -> AvisoDoPortao(
            pedido = pedido,
            titulo = "Sessão expirada",
            detalhe = "Faça o pareamento novamente para continuar.",
            acoes = listOf("Voltar" to voltar),
        )
    }
}

internal const val ROTULO_VER_PLANOS = "Ver planos"

/** A arte do conteudo esperando, com uma linha de estado. */
@Composable
private fun Espera(pedido: Pedido, texto: String) {
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        ApiObaflix.imagem(pedido.backdrop, "w1280")?.let {
            AsyncImage(
                model = it,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.72f)))
        if (texto.isNotEmpty()) {
            Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(text = texto, color = Cores.Texto, fontSize = Escala.Corpo)
                EspacoV(8.dp)
                Text(text = pedido.rotuloCompleto, color = Cores.TextoFraco, fontSize = Escala.Rotulo)
            }
        }
    }
}

/**
 * O video promocional.
 *
 * ## Sem pular, sem avancar
 *
 * Nenhum controle desenhado (`useController = false`) e toda tecla consumida,
 * exceto BACK — que cancela a tentativa pelo `BackHandler` do portao — e
 * OK/play-pause, que so pausam. Avancar, retroceder e as teclas de midia de
 * salto nao chegam ao player.
 *
 * ## Fim real, erro e interrupcao sao coisas diferentes
 *
 *  - `STATE_ENDED` com a posicao no fim → `aoTerminar`, que leva a escolha
 *    final — nunca direto a conclusao;
 *  - `STATE_ENDED` longe do fim, ou `onPlayerError` → `aoFalhar`, com opcao de
 *    tentar de novo;
 *  - sair da tela (BACK, Home, camada nova) → nada e enviado. Nao ha conclusao
 *    sem o evento de fim.
 *
 * Um evento que ja encerrou o video nao dispara outro: `encerrado` garante um so.
 *
 * ## Depois do fim
 *
 * `emExibicao = false`: o player continua composto, parado no ultimo quadro, mas
 * sem foco, sem teclas e sem textos por cima — quem tem o cursor e a escolha
 * final desenhada sobre ele.
 */
@Composable
private fun PlayerPromocional(
    videoUrl: String,
    emExibicao: Boolean,
    aoTerminar: () -> Unit,
    aoFalhar: () -> Unit,
) {
    val contexto = LocalContext.current
    val foco = remember { FocusRequester() }
    val terminar by rememberUpdatedState(aoTerminar)
    val falhar by rememberUpdatedState(aoFalhar)
    var posicaoMs by remember { mutableStateOf(0L) }
    var duracaoMs by remember { mutableStateOf(0L) }
    var pronto by remember { mutableStateOf(false) }

    val player = remember(videoUrl) {
        // `mediaClient` e nao `httpClient`: um MP4 progressivo lido devagar pelo
        // buffer morreria no timeout de leitura comum — mesmo motivo da TelaPlayer.
        val fabrica = OkHttpDataSource.Factory(ObaflixApp.mediaClient)
            .setUserAgent(SessaoTv.userAgent)
        ExoPlayer.Builder(contexto)
            .setMediaSourceFactory(DefaultMediaSourceFactory(fabrica))
            .build()
            .apply {
                setMediaItem(MediaItem.fromUri(videoUrl))
                playWhenReady = true
                prepare()
            }
    }

    DisposableEffect(player) {
        var encerrado = false
        val ouvinte = object : Player.Listener {
            override fun onPlaybackStateChanged(estado: Int) {
                if (estado == Player.STATE_READY) pronto = true
                if (estado == Player.STATE_ENDED && !encerrado) {
                    encerrado = true
                    if (terminouDeVerdade(player.currentPosition, player.duration)) terminar() else falhar()
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                if (encerrado) return
                encerrado = true
                ObaLog.alerta(ObaLog.Fase.PLAYER, "tv_promocao_falhou", "codigo" to error.errorCodeName)
                falhar()
            }
        }
        player.addListener(ouvinte)
        onDispose {
            player.removeListener(ouvinte)
            player.release()
        }
    }

    // Aplicativo em segundo plano pausa o video. O relogio do servidor segue
    // contando, o que so pode atrasar a conclusao — nunca adianta-la.
    val ciclo = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(ciclo, player) {
        val observador = LifecycleEventObserver { _, evento ->
            when (evento) {
                Lifecycle.Event.ON_STOP -> player.pause()
                Lifecycle.Event.ON_START -> player.play()
                else -> Unit
            }
        }
        ciclo.addObserver(observador)
        onDispose { ciclo.removeObserver(observador) }
    }

    LaunchedEffect(player, emExibicao) {
        while (emExibicao) {
            posicaoMs = player.currentPosition
            if (player.duration > 0) duracaoMs = player.duration
            delay(250)
        }
    }

    LaunchedEffect(Unit) {
        repeat(10) {
            if (!emExibicao) return@LaunchedEffect
            runCatching { foco.requestFocus() }
            delay(50)
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .then(if (emExibicao) Modifier.focusRequester(foco).focusable() else Modifier)
            .onPreviewKeyEvent { evento ->
                if (!emExibicao) return@onPreviewKeyEvent false
                when (evento.key) {
                    // Nao consumido: segue para o BackHandler do portao.
                    Key.Back, Key.Escape -> false
                    Key.MediaPlayPause, Key.DirectionCenter, Key.Enter, Key.NumPadEnter -> {
                        if (evento.type == KeyEventType.KeyDown) {
                            if (player.isPlaying) player.pause() else player.play()
                        }
                        true
                    }
                    // Setas, avancar, retroceder, proximo: engolidos.
                    else -> true
                }
            },
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                PlayerView(ctx).apply {
                    this.player = player
                    useController = false
                    isFocusable = false
                    isFocusableInTouchMode = false
                    descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    setShutterBackgroundColor(android.graphics.Color.BLACK)
                }
            },
        )

        // Sem `return` antecipado dentro do conteudo: a troca de etapa recompoe
        // este bloco, e a estrutura tem de continuar estavel (mesma causa do
        // crash em Perfil corrigido em b9a58e0).
        if (emExibicao) {
            Text(
                text = "Obaflix · vídeo promocional",
                color = Color(0xFFD4D4D8),
                fontSize = 14.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(28.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(Color(0x99000000))
                    .padding(horizontal = 10.dp, vertical = 5.dp),
            )

            if (!pronto) {
                Text(
                    text = "Carregando o vídeo…",
                    color = Cores.TextoFraco,
                    fontSize = Escala.Corpo,
                    modifier = Modifier.align(Alignment.Center),
                )
            }

            if (duracaoMs > 0) {
                val restanteSeg = ((duracaoMs - posicaoMs).coerceAtLeast(0) + 999) / 1000
                val fracao = (posicaoMs.toFloat() / duracaoMs).coerceIn(0f, 1f)
                Column(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .padding(horizontal = 48.dp, vertical = 28.dp),
                ) {
                    Text(
                        text = "O vídeo termina em " + restanteSeg + "s",
                        color = Cores.Texto,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    EspacoV(8.dp)
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(4.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(Color.White.copy(alpha = 0.22f)),
                    ) {
                        Box(Modifier.fillMaxWidth(fracao).fillMaxHeight().background(Cores.Destaque))
                    }
                }
            }
        }
    }
}

/** Estado sem video, com as acoes em botoes grandes e o primeiro focado. */
@Composable
private fun AvisoDoPortao(
    pedido: Pedido,
    titulo: String,
    detalhe: String,
    acoes: List<Pair<String, () -> Unit>>,
) {
    val primeiro = remember { FocusRequester() }
    var temFoco by remember { mutableStateOf(false) }

    LaunchedEffect(titulo) {
        repeat(12) {
            if (temFoco) return@LaunchedEffect
            withFrameNanos { }
            runCatching { primeiro.requestFocus() }
            delay(50)
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        ApiObaflix.imagem(pedido.backdrop, "w1280")?.let {
            AsyncImage(
                model = it,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.82f)))

        Column(
            modifier = Modifier
                .align(Alignment.Center)
                .fillMaxWidth(0.7f)
                .onFocusChanged { temFoco = it.hasFocus },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = titulo,
                color = Cores.Texto,
                fontSize = 26.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
            if (detalhe.isNotBlank()) {
                EspacoV(10.dp)
                Text(text = detalhe, color = Cores.TextoFraco, fontSize = 17.sp, textAlign = TextAlign.Center)
            }
            EspacoV(26.dp)
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                acoes.forEachIndexed { i, (rotulo, acao) ->
                    BotaoTv(
                        texto = rotulo,
                        principal = i == 0,
                        modifier = if (i == 0) Modifier.focusRequester(primeiro) else Modifier,
                        aoClicar = acao,
                    )
                }
            }
        }
    }
}
