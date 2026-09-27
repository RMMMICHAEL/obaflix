@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package com.obaflix.tv.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import com.obaflix.ObaflixApp
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.CanalTv
import com.obaflix.tv.catalogo.Concessao
import com.obaflix.tv.player.HandoffDeCanal
import com.obaflix.tv.player.PlayerDeMidia
import com.obaflix.tv.player.TrocaDeFonte
import com.obaflix.tv.player.WatchdogDeStall
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** O que a tela mostra sobre o canal em reproducao. */
sealed interface EstadoDoCanal {
    data object Parado : EstadoDoCanal
    data object Conectando : EstadoDoCanal
    data object Tocando : EstadoDoCanal
    /** Recusa definitiva ou teto de re-resolucao estourado. */
    data class Erro(val motivo: Concessao) : EstadoDoCanal
}

/**
 * O **unico** player da tela de canais.
 *
 * Um ExoPlayer para a tela inteira, compartilhado entre a previa e a tela
 * cheia: entrar em tela cheia so troca a superficie onde ele desenha, sem novo
 * `/play` nem re-buffer. Trocar de canal cancela o ciclo do canal anterior
 * (handoff, watchdog, espera de re-resolucao), para o player e limpa a fonte
 * **antes** de pedir o novo — nunca ha duas reproducoes ao mesmo tempo.
 *
 * A `streamUrl` vive so dentro do ExoPlayer; nada e gravado em disco.
 */
@Stable
class PlayerDeCanalTv(contexto: Context, private val escopo: CoroutineScope) {

    val player: ExoPlayer = ExoPlayer.Builder(contexto)
        .setMediaSourceFactory(
            DefaultMediaSourceFactory(
                // O mesmo OkHttp do resto do aplicativo; o `User-Agent` e o da
                // sessao. A CDN nao exige outro cabecalho.
                OkHttpDataSource.Factory(ObaflixApp.httpClient).setUserAgent(com.obaflix.tv.sessao.SessaoTv.userAgent),
            ),
        )
        .build()
        .apply { playWhenReady = true }

    var canal by mutableStateOf<CanalTv?>(null)
        private set
    var estado by mutableStateOf<EstadoDoCanal>(EstadoDoCanal.Parado)
        private set
    /** Altura do video em uso, so quando o player a reporta (selo `1080p`). */
    var alturaDoVideo by mutableStateOf<Int?>(null)
        private set
    var reproduzindo by mutableStateOf(false)
        private set
    /** Re-resolucao manual em andamento (spinner do "Atualizar canal"). */
    var atualizando by mutableStateOf(false)
        private set

    private var handoff: HandoffDeCanal? = null
    private var ciclo: Job? = null

    private val troca = TrocaDeFonte(object : PlayerDeMidia {
        override val posicaoMs: Long get() = player.currentPosition
        override val temItem: Boolean get() = player.mediaItemCount > 0
        override fun definirFonte(url: String, manterPosicao: Boolean) {
            // MIME declarado: os segmentos da CDN nao terminam em `.ts`, e o
            // ExoPlayer detecta o conteudo pelo proprio byte, nao pela extensao.
            player.setMediaItem(
                MediaItem.Builder().setUri(url).setMimeType(MimeTypes.APPLICATION_M3U8).build(),
                !manterPosicao,
            )
        }
        override fun preparar() = player.prepare()
    })

    private val ouvinte = object : Player.Listener {
        override fun onPlayerError(erro: PlaybackException) {
            // Fonte caindo ou girando: a mesma re-resolucao controlada.
            handoff?.let { h -> escopo.launch { h.aoErroDeReproducao() } }
        }
        override fun onVideoSizeChanged(tamanho: VideoSize) {
            alturaDoVideo = tamanho.height.takeIf { it > 0 }
        }
        override fun onIsPlayingChanged(tocando: Boolean) {
            reproduzindo = tocando
        }
    }

    init {
        player.addListener(ouvinte)
    }

    /** Abre o canal. O mesmo canal ja tocando nao reabre (nem pede `/play`). */
    fun abrir(novo: CanalTv) {
        if (canal?.id == novo.id && estado !is EstadoDoCanal.Erro) return
        encerrarCiclo()
        canal = novo
        estado = EstadoDoCanal.Conectando
        alturaDoVideo = null

        val h = HandoffDeCanal(
            canalId = novo.id,
            pedir = { id, reresolucao -> ApiObaflix.concessaoDeCanal(id, reresolucao) },
            trocarFonte = { url ->
                troca.aplicar(url)
                player.playWhenReady = true
                estado = EstadoDoCanal.Tocando
            },
            aoPerder = { motivo ->
                estado = EstadoDoCanal.Erro(motivo)
                player.stop()
            },
            esperar = { delay(it) },
        )
        handoff = h
        ciclo = escopo.launch {
            try {
                h.iniciar()
                vigiarStall(h)
            } finally {
                h.parar()
            }
        }
    }

    /**
     * "Atualizar canal": a mesma re-resolucao do erro de reproducao
     * (single-flight + teto). Com o canal em erro, recomeca o canal do zero —
     * e o "tentar de novo". Nunca recarrega a tela nem o catalogo.
     */
    fun atualizar() {
        val atual = canal ?: return
        if (estado is EstadoDoCanal.Erro) {
            canal = null
            abrir(atual)
            return
        }
        val h = handoff ?: return
        if (atualizando) return
        atualizando = true
        escopo.launch {
            try { h.aoErroDeReproducao() } finally { atualizando = false }
        }
    }

    fun alternarPausa() {
        player.playWhenReady = !player.playWhenReady
    }

    /** Solta o canal atual por inteiro: ciclo, handoff, watchdog e fonte. */
    private fun encerrarCiclo() {
        ciclo?.cancel()
        ciclo = null
        handoff?.parar()
        handoff = null
        player.stop()
        player.clearMediaItems()
        atualizando = false
    }

    fun liberar() {
        encerrarCiclo()
        player.removeListener(ouvinte)
        player.release()
    }

    /** Stall silencioso: posicao parada com o player querendo tocar. */
    private suspend fun vigiarStall(h: HandoffDeCanal) {
        val watchdog = WatchdogDeStall()
        var pausado: Boolean? = null
        while (true) {
            delay(1_000)
            val t = System.currentTimeMillis()
            // So a mudanca conta: "nao pausado" a cada segundo zeraria o relogio.
            val agoraPausado = !player.playWhenReady
            if (agoraPausado != pausado) {
                pausado = agoraPausado
                watchdog.definirPausado(agoraPausado, t)
            }
            watchdog.progrediu(player.currentPosition, t)
            if (estado == EstadoDoCanal.Tocando && watchdog.deveReresolver(t)) h.aoErroDeReproducao()
        }
    }
}

/** O player da tela, liberado quando a tela sai da composicao. */
@Composable
fun rememberPlayerDeCanalTv(): PlayerDeCanalTv {
    val contexto = LocalContext.current
    val escopo = rememberCoroutineScope()
    val controle = remember { PlayerDeCanalTv(contexto, escopo) }
    DisposableEffect(controle) { onDispose { controle.liberar() } }
    return controle
}
