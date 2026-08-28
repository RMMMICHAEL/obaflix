package com.obaflix.tv.sessao

import android.content.Context
import com.obaflix.bridge.ObaLog
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

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
    /** Verificando o que esta guardado. Estado inicial, nunca volta a ele. */
    data object Inicializando : EstadoApp

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
     * Fica dentro de `restaurar` para a raiz continuar com tres estados limpos,
     * em vez de somar um booleano de "ja deu tempo" ao lado do estado real.
     */
    private const val SPLASH_MINIMO_MS = 600L

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
     * Com refresh guardado, renova antes de perguntar: o access token vive so em
     * memoria e nao sobrevive ao fechamento do aplicativo, entao toda abertura
     * depois da primeira passa por aqui. Renovou, entra direto na Home sem
     * mostrar QR nenhum.
     */
    suspend fun restaurar(context: Context) {
        val comeco = System.currentTimeMillis()

        val temRefresh = ArmazenamentoSessao.refreshToken(context) != null
        val renovou = if (temRefresh) PareamentoTv.renovar(context) else false

        val decorrido = System.currentTimeMillis() - comeco
        if (decorrido < SPLASH_MINIMO_MS) delay(SPLASH_MINIMO_MS - decorrido)

        // Publica pelos mesmos metodos que todo o resto usa. Atribuir
        // `_estado.value` direto daqui funcionava, mas pulava o log — e foi
        // exatamente o que deixou a inicializacao invisivel no logcat.
        if (renovou) {
            marcarAutenticado(ArmazenamentoSessao.deviceId(context))
        } else {
            // Sem refresh, ou refresh recusado (expirado, revogado, reutilizado).
            // Em qualquer um dos casos o caminho e o mesmo: parear de novo.
            marcarNaoAutenticado()
        }
    }
}
