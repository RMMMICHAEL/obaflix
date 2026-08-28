package com.obaflix.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import coil.Coil
import coil.ImageLoader
import coil.disk.DiskCache
import coil.memory.MemoryCache
import com.obaflix.bridge.ObaLog
import com.obaflix.tv.sessao.EstadoApp
import com.obaflix.tv.sessao.SessaoAtual
import com.obaflix.tv.ui.TelaHome
import com.obaflix.tv.ui.TelaPareamento
import com.obaflix.tv.ui.TelaSplash
import com.obaflix.tv.ui.TemaObaflixTv

/**
 * Unica Activity do aplicativo de TV.
 *
 * A navegacao inteira sai de um estado so, publicado por `SessaoAtual`. Quem
 * autentica nao chama tela nenhuma: persiste a sessao e muda o estado. A raiz
 * reage. Isso vale igual para o pareamento, para a renovacao no boot e para o
 * logout — tres caminhos, um mecanismo, nenhuma Activity recriada.
 */
class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        ObaLog.evento(
            ObaLog.Fase.SESSAO, "tv_iniciada",
            "versao" to BuildConfig.VERSION_NAME,
            "diag" to BuildConfig.DIAG_LOGS,
        )

        configurarImagens()
        setContent { TemaObaflixTv { Raiz() } }
    }
}

/**
 * Limites do cache de imagem.
 *
 * O padrao do Coil reserva uma fatia da heap pensada para celular. Numa TV Box
 * de 1 GB isso derruba o aplicativo assim que a Home carrega meia duzia de
 * fileiras de poster. 15% da heap e um disco pequeno seguram o catalogo sem
 * empurrar o resto para fora da memoria.
 *
 * `crossfade` desligado tambem e escolha de aparelho fraco: a animacao custa
 * uma composicao extra por imagem e, com muitas entrando ao mesmo tempo numa
 * fileira, o que aparece na tela e engasgo, nao suavidade.
 */
private fun ComponentActivity.configurarImagens() {
    Coil.setImageLoader {
        ImageLoader.Builder(this)
            .memoryCache { MemoryCache.Builder(this).maxSizePercent(0.15).build() }
            .diskCache {
                DiskCache.Builder()
                    .directory(cacheDir.resolve("imagens"))
                    .maxSizeBytes(96L * 1024 * 1024)
                    .build()
            }
            .crossfade(false)
            .build()
    }
}

@Composable
private fun Raiz() {
    val context = LocalContext.current
    val estado by SessaoAtual.estado.collectAsState()

    // Roda uma vez por processo. Reentrar na composicao — troca de tema, giro,
    // recomposicao — nao dispara outra verificacao, entao nao ha como cair num
    // ciclo de checar sessao e voltar para o splash.
    LaunchedEffect(Unit) { SessaoAtual.restaurar(context) }

    when (estado) {
        is EstadoApp.Inicializando -> TelaSplash()
        is EstadoApp.NaoAutenticado -> TelaPareamento()
        is EstadoApp.Autenticado -> TelaHome(aoSair = { /* SessaoAtual ja mudou o estado */ })
    }
}
