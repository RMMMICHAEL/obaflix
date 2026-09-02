package com.obaflix.update

import android.content.Context
import com.obaflix.bridge.ObaLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/** O que a checagem/download de atualizacao esta fazendo agora. */
sealed interface EstadoAtualizacao {
    /** Nada em andamento — ultima checagem nao achou nada, ou ainda nao rodou. */
    object Ocioso : EstadoAtualizacao

    object Verificando : EstadoAtualizacao

    object Baixando : EstadoAtualizacao

    /** Baixada, conferida (tamanho/sha256 quando o manifesto os trouxe) e pronta para instalar. */
    data class Pronta(val info: PlatformUpdate, val arquivo: File) : EstadoAtualizacao

    /** Checagem ou download falharam desta vez. So informativo — a proxima recheckagem tenta de novo. */
    data class Falhou(val motivo: String) : EstadoAtualizacao
}

/**
 * Orquestra checagem + download da atualizacao, compartilhado por `:app` e
 * `:tv` — a mesma logica que o Electron ja usa (checar, baixar em segundo
 * plano, so avisar quando estiver pronto para instalar; nunca reinstalar
 * sozinho). O que muda entre celular e TV nao e esta camada, e a
 * apresentacao: ver `ObaflixBridge.installUpdate` e
 * `com.obaflix.tv.ui.CamadaAtualizacao`.
 *
 * Estado global do processo, sem escopo de Activity/Composable de proposito:
 * uma rotacao de tela ou uma navegacao entre Activities (TV) nao pode
 * reiniciar um download que ja esta em andamento.
 */
object Atualizador {

    // Mesmo intervalo do autoUpdater do Electron (ver desktop/electron/updater.js).
    private const val INTERVALO_RECHECAGEM_MS = 4 * 60 * 60 * 1000L

    private val escopo = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _estado = MutableStateFlow<EstadoAtualizacao>(EstadoAtualizacao.Ocioso)
    val estado: StateFlow<EstadoAtualizacao> = _estado.asStateFlow()

    private var job: Job? = null
    private var versionCodeJaBaixado = -1

    /**
     * Inicia o laco de checagem periodica. Idempotente: uma segunda chamada
     * no mesmo processo (nova Activity, rotacao) nao abre um segundo laco.
     */
    fun iniciar(context: Context, manifestUrl: String, plataforma: Plataforma, versionCodeAtual: Int) {
        if (job?.isActive == true) return
        val appContext = context.applicationContext
        job = escopo.launch {
            while (isActive) {
                verificarUmaVez(appContext, manifestUrl, plataforma, versionCodeAtual)
                delay(INTERVALO_RECHECAGEM_MS)
            }
        }
    }

    private suspend fun verificarUmaVez(
        context: Context,
        manifestUrl: String,
        plataforma: Plataforma,
        versionCodeAtual: Int,
    ) {
        _estado.value = EstadoAtualizacao.Verificando
        ObaLog.evento(
            ObaLog.Fase.ATUALIZACAO, "verificando",
            "plataforma" to plataforma.chave,
            "versionCodeAtual" to versionCodeAtual,
        )

        when (val resultado = UpdateChecker.verificar(manifestUrl, plataforma, versionCodeAtual)) {
            is ResultadoVerificacao.SemConexao -> {
                ObaLog.alerta(ObaLog.Fase.ATUALIZACAO, "sem_conexao", "causa" to resultado.causa)
                _estado.value = EstadoAtualizacao.Ocioso
            }

            is ResultadoVerificacao.ManifestoInvalido -> {
                ObaLog.alerta(ObaLog.Fase.ATUALIZACAO, "manifesto_invalido", "causa" to resultado.causa)
                _estado.value = EstadoAtualizacao.Ocioso
            }

            is ResultadoVerificacao.PlataformaAusente -> {
                ObaLog.evento(ObaLog.Fase.ATUALIZACAO, "plataforma_ausente", "plataforma" to resultado.plataforma)
                _estado.value = EstadoAtualizacao.Ocioso
            }

            ResultadoVerificacao.JaAtualizado -> {
                ObaLog.evento(ObaLog.Fase.ATUALIZACAO, "ja_atualizado")
                _estado.value = EstadoAtualizacao.Ocioso
            }

            is ResultadoVerificacao.NovaVersao -> {
                // Ja temos exatamente esta versao baixada e pronta — nao baixa
                // de novo so porque o relogio da recheckagem periodica virou.
                if (resultado.info.versionCode == versionCodeJaBaixado) return

                ObaLog.evento(
                    ObaLog.Fase.ATUALIZACAO, "nova_versao",
                    "versionName" to resultado.info.versionName,
                    "versionCode" to resultado.info.versionCode,
                )
                _estado.value = EstadoAtualizacao.Baixando

                when (val download = UpdateDownloader.baixar(context, resultado.info)) {
                    is ResultadoDownload.Pronto -> {
                        versionCodeJaBaixado = resultado.info.versionCode
                        ObaLog.evento(
                            ObaLog.Fase.ATUALIZACAO, "pronta",
                            "versionCode" to resultado.info.versionCode,
                        )
                        _estado.value = EstadoAtualizacao.Pronta(resultado.info, download.arquivo)
                    }

                    is ResultadoDownload.Falhou -> {
                        ObaLog.alerta(ObaLog.Fase.ATUALIZACAO, "download_falhou", "motivo" to download.motivo)
                        _estado.value = EstadoAtualizacao.Falhou(download.motivo)
                    }
                }
            }
        }
    }
}
