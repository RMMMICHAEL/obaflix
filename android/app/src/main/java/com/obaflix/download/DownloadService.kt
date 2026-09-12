package com.obaflix.download

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.obaflix.MainActivity
import com.obaflix.R
import com.obaflix.bridge.ObaLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * Baixa em segundo plano, independente da Activity.
 *
 * ## Por que servico em primeiro plano, e nao WorkManager
 *
 * A autorizacao da fonte tem prazo — a URL do CDN vem assinada e vence. Um
 * `Worker` pode ser adiado pelo sistema por minutos ou horas conforme bateria e
 * rede, e acordaria com um token ja morto. Um download comecado agora precisa
 * rodar agora; um servico em primeiro plano com notificacao visivel e o
 * contrato do Android para exatamente esse caso.
 *
 * A Activity pode fechar a qualquer momento — o servico continua, porque nada
 * aqui depende dela: fila, estado e progresso vivem no [DownloadStore], e a
 * notificacao e o que mantem o processo vivo. [ouvinte] e so um atalho para
 * atualizar a tela **quando** ela existe; se nao existir, o download continua e
 * a tela le o estado gravado quando voltar.
 */
class DownloadService : Service() {

    companion object {
        const val ACAO_ENFILEIRAR = "com.obaflix.download.ENFILEIRAR"
        const val ACAO_CANCELAR = "com.obaflix.download.CANCELAR"
        const val EXTRA_ID = "id"

        private const val CANAL = "obaflix_downloads"
        private const val NOTIF_ID = 4201

        /**
         * Quem quer saber de progresso enquanto a tela existe.
         *
         * Deliberadamente fraco no sentido de contrato: o servico nunca depende
         * de haver alguem aqui. A MainActivity registra ao subir e limpa ao
         * morrer.
         */
        @Volatile
        var ouvinte: ((DownloadRecord) -> Unit)? = null

        fun enfileirar(context: Context, id: Int) {
            val intent = Intent(context, DownloadService::class.java).apply {
                action = ACAO_ENFILEIRAR
                putExtra(EXTRA_ID, id)
            }
            // startForegroundService obriga o servico a chamar startForeground
            // em poucos segundos, e e por isso que onStartCommand faz isso como
            // primeira coisa, antes de qualquer trabalho.
            context.startForegroundService(intent)
        }

        fun cancelar(context: Context, id: Int) {
            val intent = Intent(context, DownloadService::class.java).apply {
                action = ACAO_CANCELAR
                putExtra(EXTRA_ID, id)
            }
            context.startService(intent)
        }
    }

    private val escopo = CoroutineScope(SupervisorJob())
    private val trabalhos = ConcurrentHashMap<Int, Job>()
    private lateinit var store: DownloadStore
    private lateinit var downloader: MediaDownloader

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        store = DownloadStore(PrefsKeyValueStore(applicationContext))
        downloader = MediaDownloader(contentResolver)
        criarCanal()
        // Um processo morto no meio de um download deixa registros gravados como
        // BAIXANDO que nunca mais mudam sozinhos.
        store.reconciliarNaSubida()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Antes de tudo: o sistema derruba o processo se startForeground nao
        // vier logo depois de startForegroundService.
        promoverAPrimeiroPlano(notificacao("Downloads", "Preparando", -1))

        when (intent?.action) {
            ACAO_CANCELAR -> {
                val id = intent.getIntExtra(EXTRA_ID, -1)
                cancelarDownload(id)
            }
            ACAO_ENFILEIRAR -> {
                val id = intent.getIntExtra(EXTRA_ID, -1)
                if (id > 0) escopo.launch { processar(id) }
            }
        }

        if (trabalhos.isEmpty() && store.emAndamento().isEmpty()) encerrarSeOcioso()
        // START_NOT_STICKY: nao faz sentido o sistema recriar o servico sem
        // Intent depois de matar o processo — a autorizacao da fonte que estava
        // em memoria ja se foi, e reconciliarNaSubida ja marcou o registro.
        return START_NOT_STICKY
    }

    private fun cancelarDownload(id: Int) {
        if (id <= 0) return
        trabalhos.remove(id)?.cancel()
        store.porId(id)?.let { registro ->
            if (!registro.state.terminal) {
                publicar(registro.copy(state = DownloadState.CANCELADO))
                ObaLog.evento("download", "download_cancelled", "id" to id, "kind" to registro.kind.name.lowercase())
            }
        }
        encerrarSeOcioso()
    }

    private suspend fun processar(id: Int) {
        val inicial = store.porId(id) ?: return
        if (inicial.state.terminal) return

        trabalhos[id] = currentJob()
        val comeco = System.currentTimeMillis()

        try {
            val pasta = DownloadFolder.arvoreValida(applicationContext)
            if (pasta == null) {
                publicar(inicial.copy(state = DownloadState.FALHOU, falha = DownloadFailure.PASTA_INVALIDA))
                ObaLog.alerta("download", "download_failed", "id" to id, "motivo" to "pasta_invalida")
                return
            }

            var atual = publicar(inicial.copy(state = DownloadState.PREPARANDO))
            ObaLog.evento(
                "download", "download_started",
                "id" to id,
                "kind" to atual.kind.name.lowercase(),
                "host" to ObaLog.host(atual.url),
            )

            val source = DownloadSource(
                url = atual.url,
                referer = atual.referer,
                userAgent = atual.userAgent,
                kind = atual.kind,
                expiresAt = null,
            )

            // Progresso: grava no store com parcimonia. Uma escrita a cada
            // buffer de 64 KB seria uma escrita em SharedPreferences por
            // milissegundo — a notificacao e a tela nao acompanham isso e o
            // disco paga por nada.
            var ultimaPublicacao = 0L
            val sink = object : ProgressoSink {
                override fun avancou(bytes: Long, bytesTotal: Long, segmentosFeitos: Int, segmentosTotal: Int) {
                    val agora = System.currentTimeMillis()
                    if (agora - ultimaPublicacao < 700L) return
                    ultimaPublicacao = agora
                    atual = publicar(
                        atual.copy(
                            state = DownloadState.BAIXANDO,
                            bytesBaixados = bytes,
                            bytesTotal = bytesTotal,
                            segmentosBaixados = segmentosFeitos,
                            segmentosTotal = segmentosTotal,
                        )
                    )
                    atualizarNotificacao(atual)
                }
            }

            val resultado = when (atual.kind) {
                MediaKind.MP4 -> downloader.baixarMp4(
                    source, pasta, DownloadFolder.nomeSeguro(atual.titulo, "mp4"), sink,
                )
                MediaKind.HLS -> downloader.baixarHls(
                    source, pasta, DownloadFolder.nomeSeguro(atual.titulo, "hls"), sink,
                    // A escolha do usuario viaja junto: se a URL guardada ainda
                    // for um master, e ela que decide a variante.
                    varianteId = atual.qualidadeId,
                )
            }

            publicar(
                atual.copy(
                    state = DownloadState.CONCLUIDO,
                    bytesBaixados = resultado.bytes,
                    segmentosBaixados = resultado.segmentos,
                    saidaUri = resultado.saidaUri,
                    falha = null,
                )
            )
            ObaLog.evento(
                "download", "download_complete",
                "id" to id,
                "kind" to atual.kind.name.lowercase(),
                "mb" to (resultado.bytes / (1024 * 1024)),
                "ms" to (System.currentTimeMillis() - comeco),
            )
        } catch (e: kotlinx.coroutines.CancellationException) {
            // Cancelamento ja foi publicado por cancelarDownload; nao sobrescreve.
            throw e
        } catch (e: DownloadException) {
            store.porId(id)?.let { publicar(it.copy(state = DownloadState.FALHOU, falha = e.motivo)) }
            ObaLog.alerta("download", "download_failed", "id" to id, "motivo" to e.motivo.name.lowercase())
        } catch (e: Exception) {
            store.porId(id)?.let {
                publicar(it.copy(state = DownloadState.FALHOU, falha = DownloadFailure.DESCONHECIDO))
            }
            ObaLog.alerta("download", "download_failed", "id" to id, "motivo" to "desconhecido")
        } finally {
            trabalhos.remove(id)
            // A fila e sequencial: um download de cada vez. Varios ao mesmo
            // tempo dividem a mesma banda e fazem todos demorarem mais, com a
            // chance extra de a autorizacao do ultimo vencer na espera.
            val proximo = store.proximoNaFila()
            if (proximo != null) {
                escopo.launch { processar(proximo.id) }
            } else {
                encerrarSeOcioso()
            }
        }
    }

    private suspend fun currentJob(): Job =
        kotlinx.coroutines.currentCoroutineContext()[Job]!!

    /** Grava e avisa a tela, se houver tela. */
    private fun publicar(registro: DownloadRecord): DownloadRecord {
        val salvo = store.salvar(registro)
        runCatching { ouvinte?.invoke(salvo) }
        return salvo
    }

    private fun encerrarSeOcioso() {
        if (trabalhos.isNotEmpty()) return
        if (store.proximoNaFila() != null) return
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // -- Notificacao ----------------------------------------------------------

    private fun criarCanal() {
        val canal = NotificationChannel(CANAL, "Downloads", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Progresso dos downloads do Obaflix"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(canal)
    }

    private fun notificacao(titulo: String, texto: String, progresso: Int): Notification {
        val abrir = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CANAL)
            .setContentTitle(titulo)
            .setContentText(texto)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(abrir)
            .apply {
                if (progresso >= 0) setProgress(100, progresso, false)
                else setProgress(0, 0, true)
            }
            .build()
    }

    private fun atualizarNotificacao(registro: DownloadRecord) {
        val texto = when (registro.state) {
            DownloadState.PREPARANDO -> "Preparando"
            DownloadState.BAIXANDO ->
                if (registro.progresso >= 0) "Baixando ${registro.progresso}%" else "Baixando"
            else -> registro.state.name.lowercase()
        }
        runCatching {
            getSystemService(NotificationManager::class.java)
                ?.notify(NOTIF_ID, notificacao(registro.titulo, texto, registro.progresso))
        }
    }

    /**
     * `startForeground` com o tipo declarado a partir do Android 10.
     *
     * A partir do Android 14 o tipo e obrigatorio e tem de casar com o
     * `foregroundServiceType` do manifesto e com a permissao
     * `FOREGROUND_SERVICE_DATA_SYNC`, senao o sistema lanca. Abaixo de 10 a
     * sobrecarga com tipo nem existe.
     */
    private fun promoverAPrimeiroPlano(notificacao: Notification) {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notificacao, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(NOTIF_ID, notificacao)
            }
        }
    }

    override fun onDestroy() {
        escopo.cancel()
        ouvinte = null
        super.onDestroy()
    }
}
