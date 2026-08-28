package com.obaflix.tv.sessao

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.obaflix.bridge.ObaLog

/**
 * Onde a credencial da TV fica guardada.
 *
 * O refresh token e a unica coisa persistida — o access token vive so em
 * memoria e dura 15 minutos, entao nao vale a pena grava-lo em lugar nenhum.
 *
 * Da API 23 em diante o arquivo e cifrado com chave do Android Keystore, que
 * nao sai do aparelho. Abaixo disso o EncryptedSharedPreferences nao existe
 * (o Keystore so ganhou AES na 23) e a alternativa e o arquivo comum.
 *
 * O que sustenta essa concessao: o diretorio e privado do aplicativo, e o
 * manifest declara `allowBackup="false"`, entao nao ha copia saindo do
 * aparelho por backup do sistema. Sobra o caso de aparelho com root — e ai o
 * refresh token e revogavel do lado do servidor, que e a protecao que de fato
 * importa. Um TV Box com Android 5 e um aparelho que o dono controla.
 */
object ArmazenamentoSessao {

    private const val ARQUIVO = "obaflix_tv_sessao"
    private const val ARQUIVO_SIMPLES = "obaflix_tv_sessao_simples"
    private const val CHAVE_REFRESH = "refresh"
    private const val CHAVE_DEVICE = "device"

    @Volatile
    private var cache: SharedPreferences? = null

    private fun prefs(context: Context): SharedPreferences {
        cache?.let { return it }
        synchronized(this) {
            cache?.let { return it }
            val criado = abrir(context)
            cache = criado
            return criado
        }
    }

    private fun abrir(context: Context): SharedPreferences {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val cifrado = runCatching {
                val chave = MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()
                EncryptedSharedPreferences.create(
                    context,
                    ARQUIVO,
                    chave,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                )
            }
            cifrado.onSuccess { return it }
            // Keystore quebrado acontece em aparelho de fabricante descuidado.
            // Registrar e seguir e melhor do que o app nao abrir.
            ObaLog.alerta(
                ObaLog.Fase.SESSAO, "keystore_indisponivel",
                "erro" to (cifrado.exceptionOrNull()?.javaClass?.simpleName ?: "?"),
            )
        } else {
            ObaLog.alerta(ObaLog.Fase.SESSAO, "sessao_sem_cifra", "sdk" to Build.VERSION.SDK_INT)
        }
        return context.getSharedPreferences(ARQUIVO_SIMPLES, Context.MODE_PRIVATE)
    }

    fun refreshToken(context: Context): String? =
        prefs(context).getString(CHAVE_REFRESH, null)

    fun deviceId(context: Context): String? =
        prefs(context).getString(CHAVE_DEVICE, null)

    fun salvar(context: Context, refreshToken: String, deviceId: String) {
        prefs(context).edit()
            .putString(CHAVE_REFRESH, refreshToken)
            .putString(CHAVE_DEVICE, deviceId)
            .apply()
    }

    /** Apaga tudo. Chamado no logout e quando o servidor manda reautenticar. */
    fun limpar(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
