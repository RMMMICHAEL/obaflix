package com.obaflix.update

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import kotlinx.coroutines.delay
import java.io.File
import java.security.MessageDigest

sealed interface ResultadoDownload {
    data class Pronto(val arquivo: File) : ResultadoDownload
    data class Falhou(val motivo: String) : ResultadoDownload
}

/**
 * Baixa o instalador oficial usando o `DownloadManager` do sistema.
 *
 * Por que o `DownloadManager` e nao um GET com OkHttp direto: e o proprio
 * Android quem fica dono do download — aparece no gerenciador de downloads e
 * numa notificacao do sistema (nada silencioso), sobrevive o app sendo morto
 * em segundo plano, e tenta de novo sozinho numa queda de conexao. Reimplementar
 * isso por cima do OkHttp seria repetir o que o sistema ja resolve.
 *
 * O arquivo cai em armazenamento **privado** do app
 * (`getExternalFilesDir(DIRECTORY_DOWNLOADS)`), nao na pasta publica de
 * Downloads: nenhuma permissao de armazenamento e necessaria em nenhuma
 * versao do Android, e o FileProvider (ver `res/xml/file_paths.xml`) e quem
 * cede um `content://` temporario para o instalador do sistema enxergar esse
 * arquivo sem o app abrir mao do resto do proprio espaco.
 */
object UpdateDownloader {

    private const val NOME_ARQUIVO = "obaflix-update.apk"

    // Acima disso desiste e libera a fila: um download parado (sem rede, por
    // exemplo) nao pode ficar ocupando o `DownloadManager` para sempre — a
    // proxima recheckagem periodica tenta de novo do zero.
    private const val ESPERA_MAXIMA_MS = 10 * 60 * 1000L
    private const val INTERVALO_CONSULTA_MS = 700L

    private fun arquivoDestino(context: Context): File =
        File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), NOME_ARQUIVO)

    suspend fun baixar(context: Context, info: PlatformUpdate): ResultadoDownload {
        val gerenciador = context.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
            ?: return ResultadoDownload.Falhou("DownloadManager indisponivel neste aparelho")

        val destino = arquivoDestino(context)
        // Download anterior incompleto ou de uma versao antiga nao pode ser
        // reaproveitado por engano — o proximo enqueue escreve do zero.
        destino.delete()

        val id = try {
            val pedido = DownloadManager.Request(Uri.parse(info.url)).apply {
                setTitle("Obaflix ${info.versionName}")
                setDescription("Baixando atualização")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_ONLY_COMPLETION)
                setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, NOME_ARQUIVO)
                setAllowedOverMetered(true)
                setAllowedOverRoaming(true)
                setMimeType("application/vnd.android.package-archive")
            }
            gerenciador.enqueue(pedido)
        } catch (e: Exception) {
            return ResultadoDownload.Falhou("pedido de download invalido: ${e.message}")
        }

        val erro = aguardarConclusao(gerenciador, id)
        if (erro != null) {
            runCatching { gerenciador.remove(id) }
            return ResultadoDownload.Falhou(erro)
        }

        // "Sucesso" no DownloadManager so quer dizer que a transferencia HTTP
        // terminou. Sem conferir o arquivo em si, uma resposta truncada ou
        // trocada no meio do caminho vira APK corrompido entregue direto ao
        // instalador do sistema.
        if (!destino.exists() || destino.length() == 0L) {
            return ResultadoDownload.Falhou("arquivo baixado esta vazio ou ausente")
        }
        info.size?.let { esperado ->
            if (destino.length() != esperado) {
                destino.delete()
                return ResultadoDownload.Falhou(
                    "tamanho nao confere: esperado=$esperado baixado=${destino.length()}",
                )
            }
        }
        info.sha256?.let { esperado ->
            val real = sha256(destino)
            if (!real.equals(esperado, ignoreCase = true)) {
                destino.delete()
                return ResultadoDownload.Falhou("sha256 nao confere com o manifesto")
            }
        }

        return ResultadoDownload.Pronto(destino)
    }

    /** Retorna null quando o download termina bem; um motivo, quando falha ou estoura o prazo. */
    private suspend fun aguardarConclusao(gerenciador: DownloadManager, id: Long): String? {
        val prazo = System.currentTimeMillis() + ESPERA_MAXIMA_MS
        while (System.currentTimeMillis() < prazo) {
            val consulta = DownloadManager.Query().setFilterById(id)
            gerenciador.query(consulta).use { cursor ->
                if (!cursor.moveToFirst()) return "download desapareceu da fila do sistema"
                when (cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                    DownloadManager.STATUS_SUCCESSFUL -> return null
                    DownloadManager.STATUS_FAILED -> {
                        val motivo = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                        return descreverFalha(motivo)
                    }
                    // PENDING, RUNNING, PAUSED: o sistema ainda esta tentando. Continua esperando.
                    else -> Unit
                }
            }
            delay(INTERVALO_CONSULTA_MS)
        }
        return "tempo esgotado apos ${ESPERA_MAXIMA_MS / 1000}s sem concluir"
    }

    private fun descreverFalha(motivo: Int): String = when {
        // Erro HTTP: o proprio DownloadManager usa o status code como motivo.
        motivo in 400..599 -> "servidor respondeu HTTP $motivo (arquivo pode nao existir mais)"
        motivo == DownloadManager.ERROR_FILE_ERROR -> "erro de arquivo local"
        motivo == DownloadManager.ERROR_HTTP_DATA_ERROR -> "dados HTTP corrompidos"
        motivo == DownloadManager.ERROR_INSUFFICIENT_SPACE -> "espaco insuficiente no aparelho"
        motivo == DownloadManager.ERROR_DEVICE_NOT_FOUND -> "armazenamento indisponivel"
        motivo == DownloadManager.ERROR_CANNOT_RESUME -> "nao foi possivel retomar o download"
        motivo == DownloadManager.ERROR_TOO_MANY_REDIRECTS -> "redirecionamentos demais"
        motivo == DownloadManager.ERROR_UNHANDLED_HTTP_CODE -> "codigo HTTP inesperado"
        else -> "falha desconhecida (codigo $motivo)"
    }

    internal fun sha256(arquivo: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        arquivo.inputStream().use { stream ->
            val buffer = ByteArray(8192)
            while (true) {
                val lidos = stream.read(buffer)
                if (lidos < 0) break
                digest.update(buffer, 0, lidos)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
