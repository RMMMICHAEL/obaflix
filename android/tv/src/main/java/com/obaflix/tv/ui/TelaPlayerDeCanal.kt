@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package com.obaflix.tv.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
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
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.tv.material3.Text
import com.obaflix.ObaflixApp
import com.obaflix.tv.catalogo.ApiObaflix
import com.obaflix.tv.catalogo.CanalTv
import com.obaflix.tv.catalogo.Concessao
import com.obaflix.tv.navegacao.Navegacao
import com.obaflix.tv.sessao.SessaoTv
import com.obaflix.tv.ui.componentes.focavel

/**
 * Reproducao de canal ao vivo.
 *
 * ## Por que nao e a `TelaPlayer`
 *
 * Aquela e a area mais sensivel do modulo: failover entre fontes, extracao,
 * legendas, faixas de audio, gravacao de progresso e proximo episodio. Canal ao
 * vivo nao tem nada disso — nao ha linha do tempo, nao ha de onde retomar e nao
 * ha proximo. Encaixar canais la dentro significaria mexer no caminho de
 * filmes e series para servir um caso que nao compartilha nenhuma regra com
 * ele; e a regressao apareceria num filme, nao num canal.
 *
 * ## O que este composable conhece
 *
 * Uma URL de manifesto no dominio de midia do Obaflix, e so. Nao ve upstream,
 * provedor, host de CDN nem Referer — o edge e quem fala com o provedor, e e la
 * que qualquer cabecalho de terceiro seria injetado. A URL vive no estado da
 * composicao e morre com ela: nada e gravado em disco, porque a concessao e
 * curta e uma URL persistida seria uma copia sobrevivendo a sessao que a
 * autorizou.
 *
 * O unico cabecalho que sai daqui e o nosso `User-Agent`, o mesmo da sessao.
 */
@Composable
fun TelaPlayerDeCanal(canal: CanalTv) {
    val contexto = LocalContext.current

    var concessao by remember { mutableStateOf<Concessao?>(null) }
    var tentativa by remember { mutableStateOf(0) }

    LaunchedEffect(canal.id, tentativa) {
        concessao = null
        concessao = ApiObaflix.concessaoDeCanal(canal.id)
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        when (val c = concessao) {
            null -> Mensagem("Conectando…", "", null) {}

            is Concessao.Liberado -> Reproducao(
                manifestUrl = c.manifestUrl,
                aoFalhar = {
                    // Falha fatal num canal ao vivo costuma ser a concessao
                    // vencida ou a fonte caindo. Vira estado de erro com acao
                    // manual, e nao repeticao automatica: insistir sozinho
                    // contra um canal que saiu do ar vira tempestade no edge.
                    concessao = Concessao.FalhaTemporaria
                },
            )

            is Concessao.PrecisaDeUpgrade -> Mensagem(
                titulo = "Canal não incluso no seu plano",
                detalhe = c.nivelExigido?.let { "Este canal faz parte do plano $it." }
                    ?: "Seu plano não inclui este canal.",
                rotuloAcao = "Voltar",
            ) { Navegacao.voltar() }

            is Concessao.SemSessao -> Mensagem(
                titulo = "Sessão expirada",
                detalhe = "Faça o pareamento novamente para continuar.",
                rotuloAcao = "Voltar",
            ) { Navegacao.voltar() }

            is Concessao.Indisponivel -> Mensagem(
                titulo = "Canal indisponível",
                detalhe = "Este canal não está no ar agora.",
                rotuloAcao = "Voltar",
            ) { Navegacao.voltar() }

            is Concessao.FalhaTemporaria -> Mensagem(
                titulo = "Não foi possível reproduzir",
                detalhe = "A transmissão foi interrompida.",
                rotuloAcao = "Tentar de novo",
            ) { tentativa++ }
        }

        Text(
            text = canal.nome + "   ·   AO VIVO",
            color = Color(0xFFD4D4D8),
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(32.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(Color(0x99000000))
                .padding(horizontal = 10.dp, vertical = 5.dp),
        )
    }
}

@Composable
private fun Reproducao(manifestUrl: String, aoFalhar: () -> Unit) {
    val contexto = LocalContext.current

    val player = remember {
        // O mesmo OkHttp do resto do aplicativo: um pool de conexoes, um
        // timeout, um lugar para ajustar. O `User-Agent` e o da sessao — o edge
        // nao exige nenhum outro cabecalho, e cabecalho de provedor, se um dia
        // for preciso, e injetado la e nao aqui.
        val fabrica = OkHttpDataSource.Factory(ObaflixApp.httpClient)
            .setUserAgent(SessaoTv.userAgent)

        ExoPlayer.Builder(contexto)
            .setMediaSourceFactory(DefaultMediaSourceFactory(fabrica))
            .build()
            .apply {
                setMediaItem(
                    MediaItem.Builder()
                        .setUri(manifestUrl)
                        // Declarado, e nao adivinhado pela extensao: a rota do
                        // edge termina em `.m3u8`, mas depender disso amarraria
                        // o player ao formato da URL.
                        .setMimeType(MimeTypes.APPLICATION_M3U8)
                        .build(),
                )
                // Ao vivo: entrar na borda, e nao no inicio do buffer.
                playWhenReady = true
                prepare()
            }
    }

    DisposableEffect(player) {
        val ouvinte = object : Player.Listener {
            override fun onPlayerError(erro: PlaybackException) {
                aoFalhar()
            }
        }
        player.addListener(ouvinte)
        onDispose {
            player.removeListener(ouvinte)
            player.release()
        }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            PlayerView(ctx).apply {
                this.player = player
                useController = false
                resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                setShutterBackgroundColor(android.graphics.Color.BLACK)
            }
        },
    )
}

/**
 * Estado sem video: conectando, recusa ou falha.
 *
 * Sempre com um alvo focavel quando ha acao — numa televisao, uma tela sem nada
 * focavel prende o cursor e deixa o BACK como unica saida.
 */
@Composable
private fun Mensagem(
    titulo: String,
    detalhe: String,
    rotuloAcao: String?,
    aoAgir: () -> Unit,
) {
    val requisitor = remember { FocusRequester() }
    LaunchedEffect(rotuloAcao) {
        if (rotuloAcao != null) runCatching { requisitor.requestFocus() }
    }

    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(titulo, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            if (detalhe.isNotBlank()) {
                Text(detalhe, color = Color(0xFF8A8A92), fontSize = 14.sp)
            }
            if (rotuloAcao != null) {
                val interacao = remember { MutableInteractionSource() }
                val focado by interacao.collectIsFocusedAsState()
                Text(
                    text = rotuloAcao,
                    color = Color.White,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .focusRequester(requisitor)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (focado) Color(0xFFDC2626) else Color(0xFF27272A))
                        .focavel(interacao = interacao, aoClicar = aoAgir)
                        .padding(horizontal = 20.dp, vertical = 10.dp),
                )
            }
        }
    }
}
