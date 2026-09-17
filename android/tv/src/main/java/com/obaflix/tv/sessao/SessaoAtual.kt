package com.obaflix.tv.sessao

import android.content.Context
import com.obaflix.bridge.ObaLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Estado de autenticacao do aplicativo — fonte unica de verdade.
 *
 * Antes a navegacao era feita por callback: a tela de pareamento avisava a raiz
 * "terminei" e a raiz trocava uma variavel local. Isso amarra a navegacao ao
 * ciclo de vida de quem chamou, e qualquer caminho que autentique fora daquela
 * tela — renovacao no boot, por exemplo — fica sem ninguem para avisar.
 *
 * Aqui o estado e global e observavel. Quem autentica so precisa persistir a
 * sessao e chamar `marcarAutenticado`; a raiz reage sozinha. Nao ha callback
 * para esquecer, nao ha Activity para recriar, e nao ha como duas telas
 * discordarem sobre se ha sessao.
 */
sealed interface EstadoApp {
    /** Verificando o que esta guardado. Estado inicial. */
    data object Inicializando : EstadoApp

    /**
     * Ha credencial guardada, mas nao deu para renova-la ainda (sem rede,
     * timeout, servidor fora). Continua no carregamento, sem mostrar login.
     */
    data class Reconectando(val tentativa: Int) : EstadoApp

    /** Sem sessao valida: a tela de pareamento assume. */
    data object NaoAutenticado : EstadoApp

    /** Com sessao: a Home assume. */
    data class Autenticado(val deviceId: String?) : EstadoApp
}

object SessaoAtual {

    private val _estado = MutableStateFlow<EstadoApp>(EstadoApp.Inicializando)
    val estado: StateFlow<EstadoApp> = _estado.asStateFlow()

    /**
     * Tempo minimo de splash.
     *
     * Sem ele, uma verificacao rapida faz a tela piscar entre logo e conteudo.
     * Fica dentro de `restaurar` para a raiz continuar com estados limpos, em vez
     * de somar um booleano de "ja deu tempo" ao lado do estado real.
     */
    private const val SPLASH_MINIMO_MS = 600L

    /** Uma restauracao por processo, mesmo com a Activity recriada. */
    private val restaurando = AtomicBoolean(false)

    /**
     * Escopo do processo, nao da tela.
     *
     * A restauracao pode ficar minutos esperando a rede. Presa ao
     * `LaunchedEffect` da Activity, uma recriacao (tema, retorno do sistema)
     * cancelaria o laco e a TV ficaria parada no carregamento.
     */
    private val escopo = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** Chamado pela raiz. Idempotente: a segunda chamada nao abre outro laco. */
    fun iniciarRestauracao(context: Context) {
        val app = context.applicationContext
        escopo.launch { restaurar(app) }
    }

    fun marcarAutenticado(deviceId: String?) {
        ObaLog.evento(ObaLog.Fase.SESSAO, "estado_autenticado")
        _estado.value = EstadoApp.Autenticado(deviceId)
    }

    fun marcarNaoAutenticado() {
        ObaLog.evento(ObaLog.Fase.SESSAO, "estado_nao_autenticado")
        _estado.value = EstadoApp.NaoAutenticado
    }

    /**
     * Decide o estado inicial a partir do que esta em disco.
     *
     * O access token vive so em memoria e nao sobrevive ao fechamento do
     * aplicativo, entao toda abertura com credencial guardada renova antes de
     * entrar. Falha temporaria (rede ainda subindo depois de ligar a TV, timeout,
     * servidor fora) **nao** e logout: fica em `Reconectando` e tenta de novo.
     * So a recusa do servidor ou a ausencia de credencial levam ao pareamento.
     *
     * Roda uma vez por processo. Uma Activity recriada com a sessao ja decidida
     * nao refaz a verificacao — antes, uma falha de rede nesse momento derrubava
     * para o pareamento quem ja estava dentro.
     */
    suspend fun restaurar(context: Context) {
        if (_estado.value !is EstadoApp.Inicializando) return
        if (!restaurando.compareAndSet(false, true)) return

        val comeco = System.currentTimeMillis()
        val decisao = restaurarSessao(
            ler = { ArmazenamentoSessao.leitura(context) },
            renovar = { PareamentoTv.renovarDetalhado(context) },
            esperar = { delay(it) },
            aoAguardar = { tentativa, motivo ->
                ObaLog.alerta(ObaLog.Fase.SESSAO, "restauracao_adiada", "tentativa" to tentativa, "motivo" to motivo)
                // O pareamento pode ter terminado por outro caminho no meio.
                if (_estado.value !is EstadoApp.Autenticado) _estado.value = EstadoApp.Reconectando(tentativa)
            },
        )

        val decorrido = System.currentTimeMillis() - comeco
        if (decorrido < SPLASH_MINIMO_MS) delay(SPLASH_MINIMO_MS - decorrido)

        // Publica pelos mesmos metodos que todo o resto usa, para o log contar a
        // inicializacao inteira.
        when (decisao) {
            is DecisaoDeAbertura.Entrar -> marcarAutenticado(decisao.deviceId)
            DecisaoDeAbertura.Parear -> marcarNaoAutenticado()
        }
    }
}
