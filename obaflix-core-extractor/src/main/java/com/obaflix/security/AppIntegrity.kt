package com.obaflix.security

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import com.obaflix.core.BuildConfig
import java.security.MessageDigest
import java.util.Locale

/**
 * Resultado da verificacao local da assinatura do APK.
 *
 * Isto detecta reempacotamento casual, mas nao e uma raiz de confianca: um
 * invasor capaz de alterar o APK tambem pode remover esta verificacao. Decisoes
 * de autorizacao continuam no servidor; o aplicativo nunca guarda um segredo
 * de backend para tentar transformar esta checagem em algo que ela nao e.
 */
enum class AppIntegrityStatus(val wireName: String) {
    NOT_CONFIGURED("not_configured"),
    TRUSTED("trusted"),
    UNTRUSTED("untrusted"),
    UNAVAILABLE("unavailable"),
}

object AppIntegrity {

    private val expected: Set<String> by lazy {
        BuildConfig.ALLOWED_SIGNING_CERTS_SHA256
            .split(',', ';')
            .map(::normalize)
            .filter { it.length == SHA256_HEX_LENGTH }
            .toSet()
    }

    fun verify(context: Context): AppIntegrityStatus {
        if (expected.isEmpty()) return AppIntegrityStatus.NOT_CONFIGURED

        val actual = runCatching { signingDigests(context.applicationContext) }
            .getOrElse { return AppIntegrityStatus.UNAVAILABLE }

        return if (actual.any(expected::contains)) {
            AppIntegrityStatus.TRUSTED
        } else {
            AppIntegrityStatus.UNTRUSTED
        }
    }

    @Suppress("DEPRECATION")
    private fun signingDigests(context: Context): Set<String> {
        val pm = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        } else {
            pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES)
        }

        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signingInfo = info.signingInfo ?: return emptySet()
            // O historico permite uma rotacao legitima da chave de assinatura.
            (signingInfo.apkContentsSigners?.toList().orEmpty() +
                signingInfo.signingCertificateHistory?.toList().orEmpty())
                .distinctBy { signature -> signature.toCharsString() }
        } else {
            info.signatures.orEmpty().toList()
        }

        return signatures.mapTo(mutableSetOf()) { signature ->
            val digest = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
            digest.joinToString("") { byte -> "%02x".format(Locale.ROOT, byte.toInt() and 0xff) }
        }
    }

    private fun normalize(value: String): String =
        value.filter(Char::isLetterOrDigit).lowercase(Locale.ROOT)

    private const val SHA256_HEX_LENGTH = 64
}
