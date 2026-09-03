// Este arquivo e o player: praticamente tudo que ele toca do Media3 esta
// marcado como instavel (PlayerView, AspectRatioFrameLayout, OkHttpDataSource,
// HttpDataSource). Optar no arquivo evita repetir a anotacao em cada funcao.
@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package com.obaflix.tv.ui

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.mediacodec.MediaCodecDecoderException
import androidx.media3.exoplayer.mediacodec.MediaCodecRenderer
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
import com.obaflix.tv.player.DiagnosticoPlayer
import com.obaflix.tv.player.Fonte
import com.obaflix.tv.player.FontesTv
import com.obaflix.tv.player.GravadorProgresso
import com.obaflix.tv.player.Pedido
import com.obaflix.tv.ui.componentes.EspacoH
import com.obaflix.tv.ui.componentes.EspacoV
import kotlinx.coroutines.Job
import okhttp3.Protocol
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
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
 * Quanto se espera o Media3 sair de BUFFERING e come�ar de fato.
 *
 * Uma fonte so conta como boa quando o player chega em READY. Extracao que
 * devolveu URL e manifesto que respondeu 200 nao provam nada: o segmento pode
 * dar 403, o codec pode nao existir no aparelho, o CDN pode aceitar a conexao e
 * nunca mandar byte. Todos esses casos apareciam como "carregando" eterno.
 */
private const val PRONTO_TIMEOUT_MS = 20_000L

/**
 * Teto absoluto da espera, mesmo com o CDN dando sinal de vida.
 *
 * Existe para o caso em que os bytes chegam mas o video nunca monta: sem ele, a
 * regra de "so desiste sem progresso" deixaria a tela presa para sempre.
 *
 * 40s, e nao 60s: em campo toda fonte que deu certo chegou ao primeiro quadro em
 * menos de 8s, e a que consumiu o teto inteiro passou 56s de tela preta antes de
 * o failover andar. Cinco vezes a pior espera boa ja e folga suficiente.
 */
private const val PACIENCIA_MAX_MS = 40_000L

/**
 * Player de televisao.
 *
 * A extracao roda no aparelho, com o extrator compartilhado; a URL real da
 * midia nunca aparece na tela, no log ou em qualquer rotulo. O que a pessoa le
 * e "Servidor 1", "Servidor 2" — o mesmo que o servidor devolve na projecao
 * publica.
 */
/**
 * Como terminou a espera por uma fonte.
 *
 * Tipo proprio, e nao `String?`, por um motivo especifico: a versao anterior
 * devolvia `null` para "ficou pronto" de dentro de um `withTimeoutOrNull`, que
 * tambem devolve `null` quando estoura o tempo. Os dois casos viravam o mesmo
 * valor, e todo sucesso era lido como timeout — a fonte boa era derrubada
 * segundos depois de comecar, com "sem_resposta_20s" no log. Sentinela nao-nula
 * torna a confusao impossivel de reaparecer.
 */
private sealed interface Preparo {
    object Pronto : Preparo
    data class Falhou(val motivo: String) : Preparo
}

/** Nome legivel do estado do player, para o log do watchdog. */
private fun nomeEstado(estado: Int): String = when (estado) {
    Player.STATE_IDLE -> "IDLE"
    Player.STATE_BUFFERING -> "BUFFERING"
    Player.STATE_READY -> "READY"
    Player.STATE_ENDED -> "ENDED"
    else -> "?" + estado
}

/**
 * Suspende ate o player comecar de fato, falhar ou estourar o tempo.
 *
 * So deve ser chamada **depois** de setMediaItem + prepare + playWhenReady: o
 * relogio vale para a preparacao daquela midia, e nao para o tempo de extracao
 * que veio antes. A contagem usa `elapsedRealtime` (monotonico), que nao anda
 * para tras se o relogio do aparelho for ajustado no meio.
 */
private suspend fun aguardarPronto(
    player: ExoPlayer,
    rotulo: String,
    diagnostico: DiagnosticoPlayer,
): Preparo {
    val inicio = SystemClock.elapsedRealtime()
    ObaLog.evento(
        ObaLog.Fase.PLAYER, "tv_watchdog_inicio",
        "servidor" to rotulo,
        "limiteMs" to PRONTO_TIMEOUT_MS,
        "prazoEm" to (inicio + PRONTO_TIMEOUT_MS),
        "estado" to nomeEstado(player.playbackState),
        "carregando" to player.isLoading,
        "playWhenReady" to player.playWhenReady,
    )

    // O relogio conta desde o ultimo sinal de vida do CDN, e nao desde o
    // comeco. Uma fonte que ainda baixa playlist e segmento esta trabalhando, e
    // derrubar por relogio absoluto matava justamente a que ia dar certo numa
    // conexao lenta. Sem progresso nenhum por PRONTO_TIMEOUT_MS, ai sim desiste;
    // o teto de PACIENCIA_MAX_MS impede a espera eterna quando o CDN fica
    // pingando bytes sem nunca montar o video.
    var fim: Preparo? = null
    var esperas = 0
    while (fim == null) {
        fim = aguardarUmaRodada(player)
        if (fim != null) break
        esperas++
        val paradoMs = SystemClock.elapsedRealtime() - diagnostico.ultimoProgressoMs
        val totalMs = SystemClock.elapsedRealtime() - inicio
        if (paradoMs >= PRONTO_TIMEOUT_MS || totalMs >= PACIENCIA_MAX_MS) break
        ObaLog.evento(
            ObaLog.Fase.PLAYER, "tv_watchdog_estendido",
            "servidor" to rotulo,
            "semProgressoMs" to paradoMs,
            "totalMs" to totalMs,
            "rodada" to esperas,
        )
    }

    val decorrido = SystemClock.elapsedRealtime() - inicio
    val resultado = fim ?: Preparo.Falhou("sem_resposta_${decorrido / 1000}s")
    ObaLog.evento(
        ObaLog.Fase.PLAYER, "tv_watchdog_fim",
        "servidor" to rotulo,
        "decorridoMs" to decorrido,
        "porTempo" to (fim == null),
        "rodadasVazias" to esperas,
        "estado" to nomeEstado(player.playbackState),
        "carregando" to player.isLoading,
        "erroPlayer" to (player.playerError?.errorCodeName ?: "-"),
    )
    return resultado
}

/** Uma rodada de espera. Devolve null quando a rodada estourou sem desfecho. */
private suspend fun aguardarUmaRodada(player: ExoPlayer): Preparo? =
    withTimeoutOrNull(PRONTO_TIMEOUT_MS) {
        // Ja pronto antes de o ouvinte entrar: acontece com midia em cache.
        if (player.playbackState == Player.STATE_READY) return@withTimeoutOrNull Preparo.Pronto
        suspendCancellableCoroutine<Preparo> { cont ->
            val ouvinte = object : Player.Listener {
                private fun encerrar(resultado: Preparo) {
                    if (!cont.isActive) return
                    // Aqui ja se esta no looper do player (e um callback dele),
                    // mas o caminho e o mesmo por seguranca.
                    player.removerNaThreadDele(this)
                    cont.resume(resultado)
                }

                override fun onPlaybackStateChanged(estado: Int) {
                    if (estado == Player.STATE_READY) encerrar(Preparo.Pronto)
                }

                // Primeiro quadro desenhado tambem encerra: em algumas fontes o
                // video ja esta na tela antes de o estado assentar em READY.
                override fun onRenderedFirstFrame() = encerrar(Preparo.Pronto)

                override fun onPlayerError(erro: PlaybackException) =
                    encerrar(Preparo.Falhou(motivoDe(erro)))
            }
            player.addListener(ouvinte)
            // NUNCA `player.removeListener` direto aqui. `invokeOnCancellation`
            // roda na thread de quem cancelou, e quem cancela por tempo e o
            // agendador do withTimeout — `kotlinx.coroutines.DefaultExecutor`.
            // Tocar no ExoPlayer de fora da thread dele lanca
            // IllegalStateException "Player is accessed on the wrong thread",
            // que num handler de cancelamento vira FATAL EXCEPTION: o
            // aplicativo fechava exatos 20s depois de o watchdog comecar,
            // justamente na fonte que ainda estava carregando.
            cont.invokeOnCancellation { player.removerNaThreadDele(ouvinte) }
        }
    }

/**
 * Remove um ouvinte na thread que o ExoPlayer exige.
 *
 * O Media3 verifica a thread em toda chamada publica e lanca se estiver errada.
 * Como a remocao pode partir de um cancelamento — e cancelamento chega em
 * qualquer thread —, o caminho seguro e sempre pelo looper do proprio player.
 */
private fun ExoPlayer.removerNaThreadDele(ouvinte: Player.Listener) {
    if (Looper.myLooper() == applicationLooper) {
        removeListener(ouvinte)
    } else {
        Handler(applicationLooper).post { removeListener(ouvinte) }
    }
}

/** Motivo legivel de uma falha do Media3, com o status HTTP quando existe. */
private fun motivoDe(erro: PlaybackException): String {
    // `errorCodeName` vem de uma constante do Media3 e sobrevive ao R8. Antes
    // isto usava `javaClass.simpleName` da causa, e no APK minificado o motivo
    // saia como "m" ou "n1" — nome ofuscado, diagnostico nenhum.
    val codigo = erro.errorCodeName
    return when (val causa = erro.cause) {
        is HttpDataSource.InvalidResponseCodeException -> codigo + "/http_" + causa.responseCode
        // Falha de decodificacao nao e falha de rede, e tratar as duas igual
        // manda trocar de servidor quando o problema e o aparelho. O mime e o
        // codec dizem se falta suporte (HEVC, AV1) ou se o decodificador do
        // aparelho simplesmente engasgou.
        is MediaCodecRenderer.DecoderInitializationException ->
            codigo + "/sem_decoder_" + (causa.mimeType ?: "?")
        is MediaCodecDecoderException ->
            codigo + "/decoder_" + (causa.codecInfo?.name ?: "?")
        else -> codigo
    }
}

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
    // Marca que o servidor da vez foi escolhido a dedo. Falha em escolha manual
    // nao pode virar avanco silencioso: quem escolheu precisa saber o que houve.
    var escolhaManual by remember { mutableStateOf(false) }
    // Ultimo indice que nasceu do bootstrap do Superflix, ou -1.
    //
    // A fonte Superflix e uma so na lista, e o bootstrap a substitui pelas
    // opcoes que ela por dentro oferece. Quem escolheu "Servidor 3" escolheu a
    // fonte inteira: as opcoes nem existiam no momento da escolha, entao
    // nenhuma delas foi escolhida por ninguem. Tratar a primeira como "escolha
    // manual" era o que parava o fluxo automatico com manual=true logo no 403
    // do player externo, sem sequer tentar a alternativa que estava do lado.
    //
    // Dentro desta janela o failover volta a ser automatico; passada a ultima
    // opcao, a escolha manual original volta a valer e a tela avisa quem
    // escolheu, exatamente como antes.
    var ultimaAlternativaDoBootstrap by remember { mutableStateOf(-1) }
    // Enquanto o preparo espera por READY, quem trata a falha e o proprio
    // preparo. Sem esta trava, o ouvinte global avancaria de fonte ao mesmo
    // tempo e as duas trocas se atropelariam.
    var aguardandoPreparo by remember { mutableStateOf(false) }

    // ── Ciclo de vida das tentativas ─────────────────────────────────────────
    // Uma tentativa por vez, e a anterior morre inteira antes de a nova comecar.
    // Sem isto, trocar de servidor deixava a espera antiga viva: ela estourava
    // 20s depois e derrubava a fonte NOVA, que estava tocando bem. A epoca e o
    // segundo cinto — se por qualquer caminho uma tentativa velha sobreviver a
    // um ponto de suspensao, ela se descobre obsoleta e sai sem tocar em nada.
    val jobPreparo = remember { java.util.concurrent.atomic.AtomicReference<Job?>(null) }
    val epoca = remember { java.util.concurrent.atomic.AtomicInteger(0) }

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

    // ── Aviso de proximo episodio ────────────────────────────────────────────
    // Só existe quando há um próximo episódio disponível. cancelouAviso zera a
    // cada episódio: cancelar vale só para o episódio atual.
    var avisoProximo by remember { mutableStateOf(false) }
    var cancelouAviso by remember(episodioAtual) { mutableStateOf(false) }
    var selecaoAviso by remember { mutableStateOf(0) }
    var pedirProximo by remember { mutableStateOf(false) }
    var primeiraAbertura by remember { mutableStateOf(true) }

    // Proximo episodio na ordem real (atravessa a virada de temporada). Só conta
    // se estiver disponivel para reproduzir.
    val proximoEp = remember(pedido.episodios, episodioAtual) {
        val idx = pedido.episodios.indexOfFirst { it.id == episodioAtual }
        if (idx >= 0) pedido.episodios.getOrNull(idx + 1)?.takeIf { it.disponivel } else null
    }

    // ── Motor ────────────────────────────────────────────────────────────────

    val fabricaHttp = remember {
        // Mesmo cliente da extracao: um pool de conexoes so. O `mediaClient` tem
        // readTimeout zero, que e o que um corpo de midia consumido devagar
        // exige — com o timeout comum, o video morre assim que o buffer enche.
        OkHttpDataSource.Factory(
            // HTTP/1.1 para a midia. Em HTTP/2 estes CDN atras de Cloudflare
            // derrubam o fluxo no meio de um segmento grande com
            // "stream was reset: INTERNAL_ERROR" — visto depois de 14s baixando
            // um segmento de video/MP2T, o que travava a fonte inteira. Sem
            // multiplexacao o segmento vem numa conexao so, que e o que o
            // player faz mesmo. `newBuilder` mantem o pool compartilhado.
            ObaflixApp.mediaClient.newBuilder()
                .protocols(listOf(Protocol.HTTP_1_1))
                .build(),
        )
            .setUserAgent(CabecalhosMidia.USER_AGENT)
    }

    // Decodificador com plano B. Quando o codec de hardware do aparelho recusa
    // ou engasga com o video — comum em TV Box e em Android 9, e o que produzia
    // ERROR_CODE_DECODING_FAILED numa fonte que baixava perfeitamente — o Media3
    // reinicia com o proximo decodificador da lista, incluindo o de software,
    // em vez de desistir da fonte. Sem isto, defeito do aparelho era lido como
    // servidor ruim, e trocar de servidor nunca resolvia.
    val fabricaRenderizadores = remember {
        DefaultRenderersFactory(context)
            .setEnableDecoderFallback(true)
    }

    // Rotulo por chamada, e nao capturado: o diagnostico vive tanto quanto o
    // player, mas precisa dizer o servidor da vez em cada linha.
    val diagnostico = remember {
        DiagnosticoPlayer(rotuloFonte = { fontes.getOrNull(fonteAtual)?.rotulo ?: "?" })
    }

    val player = remember {
        ExoPlayer.Builder(context, fabricaRenderizadores)
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
    /**
     * Registra a decisao de failover.
     *
     * So o registro, sem agir: `preparar` chama a si mesma para seguir, e duas
     * funcoes locais nao podem se chamar mutuamente em Kotlin. O que importa e
     * que parar deixe de ser mudo — numa captura de campo, uma parada sem linha
     * de log virou 13s de silencio que nao deu para explicar, nem para
     * distinguir "escolha manual, respeitei" de "acabaram as fontes".
     */
    /**
     * A escolha manual ainda prende o failover neste indice?
     *
     * Nao prende enquanto houver alternativa do mesmo bootstrap adiante: aquelas
     * opcoes nasceram depois da escolha e nunca foram escolhidas. Fora dessa
     * janela, escolha manual continua sendo escolha manual.
     */
    fun presoNaEscolhaManual(indice: Int): Boolean =
        escolhaManual && indice >= ultimaAlternativaDoBootstrap

    fun registrarFailover(indice: Int, rotulo: String, motivo: String) {
        val temProxima = indice + 1 < fontes.size
        val preso = presoNaEscolhaManual(indice)
        ObaLog.evento(
            ObaLog.Fase.PLAYER, "tv_failover",
            "de" to rotulo,
            "motivo" to motivo,
            "indice" to indice,
            "fontes" to fontes.size,
            "manual" to preso,
            // Distingue "o usuario escolheu" de "a escolha ainda tem
            // alternativas do proprio bootstrap": sem isto, o log dizia
            // manual=true numa tentativa que ninguem havia pedido.
            "escolha_usuario" to escolhaManual,
            "acao" to when {
                preso -> "para_escolha_manual"
                temProxima -> "proxima"
                else -> "para_sem_fontes"
            },
        )
    }

    suspend fun preparar(indice: Int, retomarDe: Long, minhaEpoca: Int) {
        // Tentativa obsoleta nao mexe em nada: nem no player, nem no estado da
        // tela. Quem manda e sempre a ultima chamada.
        if (epoca.get() != minhaEpoca) return
        val id = sessao ?: return
        val fonte = fontes.getOrNull(indice) ?: run {
            falha = "Nenhum servidor conseguiu abrir este conteúdo."
            carregando = false
            return
        }
        carregando = true
        falha = null

        // Mata a midia anterior ANTES de resolver a nova. Sem isto, a troca de
        // servidor deixava o stream antigo tocando durante a extracao (segundos)
        // — dois audios ao mesmo tempo. pause+stop+clear garante uma so fonte.
        player.pause()
        player.stop()
        player.clearMediaItems()

        val midia = FontesTv.resolver(id, fonte) { opcoesSuperflix ->
            if (opcoesSuperflix.isNotEmpty() && epoca.get() == minhaEpoca) {
                val atualizada = fontes.toMutableList()
                val posicao = atualizada.indexOfFirst { it.id == fonte.id }
                    .takeIf { it >= 0 } ?: indice
                atualizada.removeAt(posicao)
                atualizada.addAll(posicao, opcoesSuperflix)
                fontes = atualizada
                fonteAtual = posicao
                // A janela em que o failover volta a ser automatico mesmo depois
                // de uma escolha manual: sao as opcoes que a fonte escolhida
                // passou a oferecer, e nao escolhas de ninguem.
                ultimaAlternativaDoBootstrap = posicao + opcoesSuperflix.size - 1
                ObaLog.evento(
                    ObaLog.Fase.PROVEDOR, "superflix_bootstrap_ok",
                    "opcoes" to opcoesSuperflix.size,
                    "alternativas_ate" to ultimaAlternativaDoBootstrap,
                )
            }
        }
        if (epoca.get() != minhaEpoca) {
            ObaLog.evento(
                ObaLog.Fase.PLAYER, "tv_tentativa_obsoleta",
                "servidor" to fonte.rotulo, "fase" to "apos_extracao",
            )
            return
        }
        if (midia == null) {
            registrarFailover(indice, fonte.rotulo, "extracao_sem_midia")
            // Cai para a proxima. E o mesmo failover dos outros ambientes: a
            // pessoa nao precisa saber qual servidor falhou, so continuar vendo.
            if (!presoNaEscolhaManual(indice) && indice + 1 < fontes.size) {
                fonteAtual = indice + 1
                preparar(indice + 1, retomarDe, minhaEpoca)
            } else if (presoNaEscolhaManual(indice)) {
                falha = "Não foi possível abrir " + fonte.rotulo + ". Escolha outro no menu."
                carregando = false
            } else {
                falha = "Nenhum servidor conseguiu abrir este conteúdo."
                carregando = false
            }
            return
        }

        // O bootstrap/renovação pode remapear a opção solicitada. Propaga a
        // identidade pública efetiva antes de configurar o Media3, para que
        // diagnóstico, seleção visível e próximo failover partam da mesma fonte
        // que realmente produziu URL, Referer e User-Agent.
        var indiceEfetivo = indice
        var fonteEfetiva = fonte
        midia.effectiveOptionKey?.let { effectiveKey ->
            val encontrada = fontes.indexOfFirst { it.superflixOptionKey == effectiveKey }
            if (encontrada >= 0) {
                indiceEfetivo = encontrada
                val atual = fontes[encontrada]
                val rotulo = midia.effectiveOptionLabel ?: atual.rotulo
                val isFile = midia.effectiveOptionIsFile ?: atual.superflixIsFile
                if (rotulo != atual.rotulo || isFile != atual.superflixIsFile) {
                    val atualizadas = fontes.toMutableList()
                    atualizadas[encontrada] = atual.copy(
                        rotulo = rotulo,
                        superflixIsFile = isFile,
                    )
                    fontes = atualizadas
                    fonteEfetiva = atualizadas[encontrada]
                } else {
                    fonteEfetiva = atual
                }
                fonteAtual = indiceEfetivo
                ObaLog.evento(
                    ObaLog.Fase.PROVEDOR, "superflix_fonte_efetiva",
                    "indice" to (indiceEfetivo + 1),
                    "is_file" to fonteEfetiva.superflixIsFile,
                )
            }
        }

        // Um mapa novo por fonte. `setDefaultRequestProperties` substitui o
        // anterior inteiro, entao nao ha risco de o Referer do servidor velho
        // sobreviver na troca — o que daria 403 no servidor novo.
        val cabecalhos = CabecalhosMidia.de(midia.referer, midia.url, midia.userAgent)
        fabricaHttp.setDefaultRequestProperties(cabecalhos)
        // O UA da fabrica tambem: `setUserAgent` e o que o OkHttpDataSource usa
        // quando o mapa nao traz o cabecalho, e os dois precisam concordar. Sem
        // isto, a midia capturada no desafio saia com o UA do aplicativo e o
        // CDN respondia 403 — o link fora gerado com o UA da WebView.
        fabricaHttp.setUserAgent(midia.userAgent ?: CabecalhosMidia.USER_AGENT)

        ObaLog.evento(
            ObaLog.Fase.PLAYER, "tv_midia_preparada",
            "servidor" to fonteEfetiva.rotulo,
            "url" to ObaLog.url(midia.url),
            "legendas" to midia.legendas.size,
            "hls" to midia.ehHls,
            "cabecalhos" to CabecalhosMidia.resumo(cabecalhos),
            "retomaMs" to retomarDe,
        )

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
            // Sem esta dica o Media3 infere o tipo pela extensao da URI. Varios
            // provedores entregam o master HLS em `.urlset/master.txt`, e com
            // `.txt` ele escolhia o leitor progressivo — que nao entende
            // playlist e falhava em ~50ms, antes de qualquer rede.
            .apply { if (midia.ehHls) setMimeType(MimeTypes.APPLICATION_M3U8) }
            .setSubtitleConfigurations(legendas)
            .build()

        // A amostragem de segmentos recomeca do zero: os primeiros pedidos da
        // fonte nova sao os que interessam, e sem isto eles cairiam no meio da
        // contagem da fonte anterior e nao seriam registrados.
        diagnostico.novaFonte()
        player.setMediaItem(item, retomarDe.coerceAtLeast(0L))
        player.prepare()
        player.playWhenReady = true
        fonteAtual = indiceEfetivo

        // Só agora se sabe se a fonte presta, e só agora o relogio pode comecar:
        // o watchdog mede a preparacao desta midia, nao a extracao que veio
        // antes. Antes daqui, "carregando = false" era mentira — a extração
        // tinha respondido, mas o vídeo podia nunca comecar.
        aguardandoPreparo = true
        val resultado = try {
            aguardarPronto(player, fonteEfetiva.rotulo, diagnostico)
        } finally {
            // finally porque o cancelamento (troca de servidor no meio da
            // espera) tambem precisa liberar a trava; senao o ouvinte global
            // ficava mudo para sempre.
            aguardandoPreparo = false
        }
        if (epoca.get() != minhaEpoca) {
            ObaLog.evento(
                ObaLog.Fase.PLAYER, "tv_tentativa_obsoleta",
                "servidor" to fonte.rotulo, "fase" to "apos_watchdog",
            )
            return
        }

        if (resultado is Preparo.Pronto) {
            ObaLog.evento(
                ObaLog.Fase.PLAYER, "tv_reproducao_iniciada",
                "servidor" to fonteEfetiva.rotulo,
            )
            // Deu certo: o proximo problema volta a ter failover automatico.
            escolhaManual = false
            carregando = false
            return
        }

        val motivo = (resultado as Preparo.Falhou).motivo
        ObaLog.alerta(
            ObaLog.Fase.PLAYER, "tv_fonte_nao_iniciou",
            "servidor" to fonteEfetiva.rotulo, "motivo" to motivo,
        )
        registrarFailover(indiceEfetivo, fonteEfetiva.rotulo, motivo)
        player.pause()
        player.stop()
        player.clearMediaItems()

        if (!presoNaEscolhaManual(indiceEfetivo) && indiceEfetivo + 1 < fontes.size) {
            fonteAtual = indiceEfetivo + 1
            preparar(indiceEfetivo + 1, retomarDe, minhaEpoca)
        } else if (presoNaEscolhaManual(indiceEfetivo)) {
            falha = fonteEfetiva.rotulo + " não iniciou (" + motivo + "). Escolha outro no menu."
            carregando = false
        } else {
            falha = "Nenhum servidor conseguiu abrir este conteúdo."
            carregando = false
        }
    }

    /**
     * Ponto unico de entrada para preparar uma fonte.
     *
     * Cancela a tentativa anterior por inteiro — coroutine, espera, ouvinte — e
     * so entao comeca a nova. `cancelAndJoin` e o detalhe que importa: sem o
     * join, a tentativa velha ainda estaria correndo por alguns instantes e
     * poderia registrar a propria falha por cima da fonte que acabou de entrar.
     */
    fun iniciarPreparo(indice: Int, retomarDe: Long, manual: Boolean) {
        escolhaManual = manual
        val minhaEpoca = epoca.incrementAndGet()
        val anterior = jobPreparo.get()
        val novo = escopo.launch {
            anterior?.cancelAndJoin()
            if (epoca.get() != minhaEpoca) return@launch
            preparar(indice, retomarDe, minhaEpoca)
        }
        jobPreparo.set(novo)
    }

    // Abertura e troca de episodio. Roda toda vez que `episodioAtual` muda.
    //
    // A posicao inicial e SEMPRE a do proprio episodio: na primeira abertura vem
    // do detalhe (pedido.posicaoSeg); ao trocar de episodio, e buscada
    // especificamente para o episodio novo — 00:00 se nunca foi visto. Nunca se
    // reaproveita a posicao do player anterior.
    LaunchedEffect(pedido.conteudoId, episodioAtual) {
        carregando = true
        avisoProximo = false
        // Mata a tentativa do episodio anterior antes de tudo. Sem isto, a
        // espera dele continuava viva durante a abertura do episodio novo e
        // podia declarar falha em cima dele.
        epoca.incrementAndGet()
        jobPreparo.getAndSet(null)?.cancelAndJoin()
        // Zera a midia e a posicao antes de qualquer coisa: o episodio novo nao
        // pode herdar o quadro nem o minuto do anterior.
        player.pause()
        player.stop()
        player.clearMediaItems()
        posicaoMs = 0
        duracaoMs = 0

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
        // Lista nova, janela velha nao vale: o indice guardado apontava para
        // opcoes que nao existem mais.
        ultimaAlternativaDoBootstrap = -1

        val alvoMs: Long = when {
            primeiraAbertura -> {
                primeiraAbertura = false
                pedido.posicaoSeg * 1000L
            }
            pedido.ehSerie -> ApiObaflix.progresso(pedido.conteudoId, episodioAtual) * 1000L
            else -> 0L
        }
        iniciarPreparo(0, alvoMs, manual = false)
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

            override fun onPlaybackStateChanged(estado: Int) {
                // Episodio terminou: se ha proximo e o aviso nao foi cancelado,
                // avanca. O flag e consumido por um efeito, porque trocarEpisodio
                // e declarado abaixo.
                if (estado == Player.STATE_ENDED && proximoEp != null && !cancelouAviso) {
                    pedirProximo = true
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                // Durante o preparo quem decide e `preparar`; dois caminhos de
                // failover para a mesma falha se atropelam.
                if (aguardandoPreparo) return
                // A causa real, e nao so o codigo generico: status HTTP quando e
                // resposta do CDN, nome da excecao quando e rede ou parser. Sem
                // isto, 403 por cabecalho faltando e "fonte quebrada" ficam
                // indistinguiveis no log.
                val causa = error.cause
                val detalhe = when (causa) {
                    is HttpDataSource.InvalidResponseCodeException -> "http_" + causa.responseCode
                    null -> error.errorCodeName
                    else -> causa.javaClass.simpleName
                }
                ObaLog.falha(
                    ObaLog.Fase.PLAYER, "tv_player_erro", error,
                    "servidor" to (fontes.getOrNull(fonteAtual)?.rotulo ?: "?"),
                    "codigo" to error.errorCodeName,
                    "causa" to detalhe,
                    "manual" to presoNaEscolhaManual(fonteAtual),
                    "escolha_usuario" to escolhaManual,
                )

                if (presoNaEscolhaManual(fonteAtual)) {
                    // Quem escolheu o servidor precisa ver o que aconteceu com a
                    // escolha. Pular sozinho aqui era o que fazia "selecionei o
                    // Servidor 3 e nao funciona" — ele falhava e o player ia
                    // embora para outro sem dizer nada.
                    falha = "Este servidor não respondeu (" + detalhe + "). Escolha outro no menu."
                    carregando = false
                } else {
                    if (fonteAtual + 1 < fontes.size) {
                        iniciarPreparo(fonteAtual + 1, posicaoMs, manual = false)
                    } else {
                        falha = "A reprodução foi interrompida."
                    }
                }
            }
        }
        player.addListener(ouvinte)
        player.addAnalyticsListener(diagnostico)
        onDispose {
            salvarProgresso()
            player.removeListener(ouvinte)
            player.removeAnalyticsListener(diagnostico)
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

            // Aviso de proximo episodio nos ultimos 30s. So aparece com proximo
            // disponivel, e some se a pessoa cancelou ou voltou atras no tempo.
            if (proximoEp != null && !cancelouAviso && duracaoMs > 0 && player.isPlaying) {
                val restante = duracaoMs - posicaoMs
                avisoProximo = restante in 1..30_000
            } else if (avisoProximo && cancelouAviso) {
                avisoProximo = false
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
        // Salva o progresso do episodio ATUAL antes de trocar; o novo comeca
        // limpo e busca a propria posicao no efeito de abertura.
        salvarProgresso()
        avisoProximo = false
        posicaoMs = 0
        duracaoMs = 0
        temporadaAtual = episodio.temporada
        numeroAtual = episodio.numeroEp
        episodioAtual = episodio.id
        tituloAtual = pedido.titulo + "  ·  T" + episodio.temporada + " E" + episodio.numeroEp
        camada = Camada.Nenhuma
    }

    // Consome o pedido de avanco (fim do episodio ou contador em zero). Fica
    // aqui, depois de trocarEpisodio, porque uma funcao local so pode ser
    // chamada apos declarada.
    LaunchedEffect(pedirProximo) {
        if (pedirProximo) {
            pedirProximo = false
            proximoEp?.let { trocarEpisodio(it) }
        }
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
                // Sem o `!=`: repetir o servidor que acabou de falhar e o gesto
                // natural de quem tenta de novo, e antes isso nao fazia nada.
                iniciarPreparo(opcao, posicaoMs, manual = true)
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

        // Aviso de proximo episodio: enquanto visivel, o D-pad comanda so ele.
        // ESQUERDA/DIREITA escolhe, OK confirma, BACK cancela.
        if (avisoProximo) {
            when (tecla) {
                Key.DirectionLeft -> selecaoAviso = 0
                Key.DirectionRight -> selecaoAviso = 1
                Key.DirectionCenter, Key.Enter, Key.NumPadEnter ->
                    if (selecaoAviso == 0) proximoEp?.let { trocarEpisodio(it) }
                    else { cancelouAviso = true; avisoProximo = false }
                Key.Back, Key.Escape -> { cancelouAviso = true; avisoProximo = false }
                else -> {}
            }
            return true
        }

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

        // Aviso de proximo episodio, no canto inferior direito.
        AnimatedVisibility(
            visible = avisoProximo && proximoEp != null,
            enter = slideInVertically { it } + fadeIn(),
            exit = slideOutVertically { it } + fadeOut(),
            modifier = Modifier.align(Alignment.BottomEnd).padding(margemHorizontal(), margemVertical()),
        ) {
            AvisoProximoEpisodio(
                proximo = proximoEp,
                segundos = ((duracaoMs - posicaoMs) / 1000).toInt().coerceIn(0, 30),
                selecao = selecaoAviso,
            )
        }
    }
}

/**
 * Aviso de proximo episodio.
 *
 * Aparece nos ultimos 30s de uma serie quando ha proximo. O contador conta ate
 * o fim; sem cancelar, o episodio seguinte comeca sozinho. "Continuar" antecipa;
 * "Cancelar" deixa o atual terminar.
 */
@Composable
private fun AvisoProximoEpisodio(proximo: Episodio?, segundos: Int, selecao: Int) {
    Column(
        modifier = Modifier
            .width(360.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(Color.Black.copy(alpha = 0.92f))
            .padding(20.dp),
    ) {
        Text(
            text = "Próximo episódio em " + segundos + "s",
            color = Cores.Texto,
            fontSize = Escala.Rotulo,
            fontWeight = FontWeight.Bold,
        )
        EspacoV(4.dp)
        Text(
            text = proximo?.let { "E" + it.numeroEp + " · " + it.rotulo } ?: "",
            color = Cores.TextoFraco,
            fontSize = Escala.Miudo,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        EspacoV(14.dp)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BotaoAviso("Continuar", selecionado = selecao == 0, modifier = Modifier.weight(1f))
            BotaoAviso("Cancelar", selecionado = selecao == 1, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun BotaoAviso(texto: String, selecionado: Boolean, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (selecionado) Cores.FocoHalo else Color.White.copy(alpha = 0.14f))
            .padding(vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = texto,
            color = if (selecionado) Color(0xFF101014) else Cores.Texto,
            fontSize = Escala.Rotulo,
            fontWeight = FontWeight.Bold,
        )
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
