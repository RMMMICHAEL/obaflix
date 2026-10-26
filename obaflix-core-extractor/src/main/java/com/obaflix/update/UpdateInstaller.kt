package com.obaflix.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

/**
 * Abre o instalador do sistema para o APK ja baixado e conferido.
 *
 * Nada aqui instala silenciosamente nem pede permissao alem da necessaria: os
 * dois metodos so lancam Intents padrao do Android, e quem decide continua
 * sendo o usuario, na propria interface do sistema.
 *
 * A garantia contra um APK adulterado nao esta neste arquivo: e o proprio
 * Android quem recusa, na hora de instalar, qualquer pacote que nao esteja
 * assinado com o MESMO certificado do app ja instalado
 * (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). O `sha256` conferido em
 * [UpdateDownloader] cobre a etapa anterior — download truncado ou corrompido
 * —, nao substitui essa checagem do sistema.
 */
object UpdateInstaller {

    /** A plataforma ja concedeu a este app permissao para instalar pacotes? */
    fun podeInstalar(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.packageManager.canRequestPackageInstalls()
        } else {
            // Abaixo do Android 8 nao ha essa permissao especial: o proprio
            // instalador do sistema pergunta na hora, com seu proprio dialogo.
            true
        }

    /** Leva o usuario a tela do sistema onde ele concede a permissao. */
    fun abrirPermissaoDeInstalacao(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    /** Abre o instalador do sistema para `arquivo`. Sempre pede confirmacao explicita — nunca silencioso. */
    fun instalar(context: Context, arquivo: File) {
        val autoridade = "${context.packageName}.fileprovider"
        val uri = FileProvider.getUriForFile(context, autoridade, arquivo)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }
}
