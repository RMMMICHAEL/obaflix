package com.obaflix.tv.ui

import android.view.ViewGroup
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.tv.material3.Text
import coil.compose.AsyncImage
import com.obaflix.ObaflixApp
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.player.CabecalhosMidia
import com.obaflix.tv.player.FontesTv
import com.obaflix.tv.player.Pedido
import kotlinx.coroutines.delay

/**
 * Previa da ficha.
 *
 * A moldura nasce com a arte parada e **so** vira video se a pessoa realmente
 * parar ali: passados alguns segundos sem sair da ficha, a primeira fonte e
 * resolvida e reproduzida sem som, num quadro pequeno.
 *
 * A espera nao e enfeite. Sem ela, atravessar dez cards com o controle na mao
 * dispararia dez extracoes e dez downloads de video que ninguem chegou a ver —
 * trabalho de CDN e trafego gastos por navegacao, e nao por escolha. Com ela, a
 * previa acontece quando ha intencao, que era a condicao para existir.
 *
 * Custo no nosso lado quando ela acontece: duas chamadas pequenas de API
 * (`/player/fontes` e `/player/fonte-nativa`). A midia nao passa pela Vercel em
 * momento nenhum — o aparelho fala direto com o CDN, como no resto do player.
 */
private const val ESPERA_ANTES_MS = 7_000L

@Composable
fun PreviaMuda(pedido: Pedido, arte: String?, modifier: Modifier = Modifier) {
    var url by remember(pedido.conteudoId, pedido.episodioId) { mutableStateOf<String?>(null) }
    var referer by remember(pedido.conteudoId, pedido.episodioId) { mutableStateOf<String?>(null) }

    LaunchedEffect(pedido.conteudoId, pedido.episodioId) {
        delay(ESPERA_ANTES_MS)
        val abertura = FontesTv.abrir(pedido) ?: return@LaunchedEffect
        val primeira = abertura.fontes.firstOrNull() ?: return@LaunchedEffect
        val midia = FontesTv.resolver(abertura.sessao, primeira) ?: return@LaunchedEffect
        referer = midia.referer
        url = midia.url
    }

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .background(Color.Black),
    ) {
        ApiObaflix.imagem(arte, "w780")?.let {
            AsyncImage(
                model = it,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }

        val enderecoAtual = url
        if (enderecoAtual != null) {
            Reprodutor(enderecoAtual, referer)
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .padding(8.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(Color.Black.copy(alpha = 0.6f))
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            ) {
                Text(
                    text = "prévia sem som",
                    color = Cores.TextoFraco,
                    fontSize = Escala.Miudo,
                    fontWeight = FontWeight.Bold,
                )
            }
        } else {
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.25f)))
        }
    }
}

@Composable
private fun Reprodutor(url: String, referer: String?) {
    val context = LocalContext.current

    val player = remember(url) {
        val fabrica = OkHttpDataSource.Factory(ObaflixApp.mediaClient)
            .setUserAgent(CabecalhosMidia.USER_AGENT)
            .setDefaultRequestProperties(CabecalhosMidia.de(referer))
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(fabrica))
            .build()
            .apply {
                // Sem som e sem repeticao: a previa acompanha a ficha, nao
                // concorre com ela. Volume zero tambem evita roubar o foco de
                // audio de qualquer coisa que ja esteja tocando na sala.
                volume = 0f
                setMediaItem(MediaItem.fromUri(url))
                prepare()
                playWhenReady = true
            }
    }

    DisposableEffect(player) {
        onDispose { player.release() }
    }

    AndroidView(
        factory = {
            PlayerView(context).apply {
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                )
                this.player = player
            }
        },
        update = { it.player = player },
        modifier = Modifier.fillMaxSize(),
    )
}
