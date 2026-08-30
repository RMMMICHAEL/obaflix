package com.obaflix.tv.sessao

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.KeyPairGeneratorSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.obaflix.ObaflixApp
import com.obaflix.bridge.ObaLog
import com.obaflix.security.AppIntegrityStatus
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Calendar
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.security.auth.x500.X500Principal

/**
 * Persistencia das credenciais da TV.
 *
 * O access token continua exclusivamente em memoria. O refresh token usa
 * EncryptedSharedPreferences na API 23+; se a implementacao do fabricante
 * estiver quebrada, e tambem no Android 5, usamos envelope encryption:
 *
 *  1. uma chave AES aleatoria cifra os valores com AES-GCM;
 *  2. a chave AES e embrulhada por uma chave RSA do Android Keystore;
 *  3. apenas o blob embrulhado, IV e ciphertext ficam em SharedPreferences.
 *
 * Se nenhum modo seguro puder ser aberto, a sessao fica somente em memoria e o
 * usuario pareia de novo na proxima abertura. Nunca voltamos a texto claro.
 */
object ArmazenamentoSessao {

    private const val ARQUIVO = "obaflix_tv_sessao"
    private const val ARQUIVO_LEGADO_CIFRADO = "obaflix_tv_sessao_envelope"
    private const val ARQUIVO_SIMPLES_ANTIGO = "obaflix_tv_sessao_simples"
    private const val CHAVE_REFRESH = "refresh"
    private const val CHAVE_DEVICE = "device"

    @Volatile
    private var cache: Cofre? = null

    private interface Cofre {
        fun ler(chave: String): String?
        fun salvar(refreshToken: String, deviceId: String)
        fun limpar()
    }

    private class CofrePreferences(private val prefs: SharedPreferences) : Cofre {
        override fun ler(chave: String): String? = prefs.getString(chave, null)

        override fun salvar(refreshToken: String, deviceId: String) {
            check(
                prefs.edit()
                    .putString(CHAVE_REFRESH, refreshToken)
                    .putString(CHAVE_DEVICE, deviceId)
                    .commit(),
            ) { "Nao foi possivel persistir a sessao" }
        }

        override fun limpar() {
            prefs.edit().clear().commit()
        }
    }

    /** Cofre volatil usado quando o Keystore do fabricante nao funciona. */
    private class CofreMemoria : Cofre {
        private val valores = mutableMapOf<String, String>()

        override fun ler(chave: String): String? = synchronized(valores) { valores[chave] }

        override fun salvar(refreshToken: String, deviceId: String) {
            synchronized(valores) {
                valores[CHAVE_REFRESH] = refreshToken
                valores[CHAVE_DEVICE] = deviceId
            }
        }

        override fun limpar() = synchronized(valores) { valores.clear() }
    }

    private class CofreEnvelope(context: Context) : Cofre {
        private val appContext = context.applicationContext
        private val prefs = appContext.getSharedPreferences(
            ARQUIVO_LEGADO_CIFRADO,
            Context.MODE_PRIVATE,
        )
        private val alias = "${appContext.packageName}.session.envelope.v1"

        @Volatile
        private var aesCache: SecretKey? = null

        /** Forca um teste real do Keystore antes de escolher este backend. */
        fun validar() {
            synchronized(this) { chaveAes() }
        }

        override fun ler(chave: String): String? = synchronized(this) {
            val encoded = prefs.getString(chave, null) ?: return null
            runCatching { decifrar(chave, encoded, chaveAes()) }
                .onFailure {
                    ObaLog.alerta(
                        ObaLog.Fase.SESSAO,
                        "sessao_cifrada_invalida",
                        "erro" to it.javaClass.simpleName,
                    )
                    invalidarMaterialCriptografico()
                }
                .getOrNull()
        }

        override fun salvar(refreshToken: String, deviceId: String) = synchronized(this) {
            val key = chaveAes()
            val ok = prefs.edit()
                .putString(CHAVE_REFRESH, cifrar(CHAVE_REFRESH, refreshToken, key))
                .putString(CHAVE_DEVICE, cifrar(CHAVE_DEVICE, deviceId, key))
                .commit()
            check(ok) { "Nao foi possivel persistir a sessao cifrada" }
        }

        override fun limpar() = synchronized(this) {
            prefs.edit().clear().commit()
            aesCache = null
            runCatching {
                keyStore().apply {
                    if (containsAlias(alias)) deleteEntry(alias)
                }
            }
            Unit
        }

        private fun chaveAes(): SecretKey {
            aesCache?.let { return it }

            val store = keyStore()
            if (!store.containsAlias(alias)) gerarRsa()

            val wrapped = prefs.getString(CHAVE_AES_EMBRULHADA, null)
            val key = if (wrapped == null) {
                val raw = ByteArray(AES_KEY_BYTES).also(SecureRandom()::nextBytes)
                val publicKey = keyStore().getCertificate(alias).publicKey
                val cipher = Cipher.getInstance(RSA_TRANSFORMATION)
                cipher.init(Cipher.ENCRYPT_MODE, publicKey)
                val encoded = Base64.encodeToString(
                    cipher.doFinal(raw),
                    Base64.NO_WRAP,
                )
                check(prefs.edit().putString(CHAVE_AES_EMBRULHADA, encoded).commit()) {
                    "Nao foi possivel persistir a chave embrulhada"
                }
                SecretKeySpec(raw, "AES")
            } else {
                val privateKey = store.getKey(alias, null)
                val cipher = Cipher.getInstance(RSA_TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, privateKey)
                SecretKeySpec(
                    cipher.doFinal(Base64.decode(wrapped, Base64.NO_WRAP)),
                    "AES",
                )
            }

            aesCache = key
            return key
        }

        private fun gerarRsa() {
            val generator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_RSA,
                ANDROID_KEYSTORE,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                generator.initialize(
                    KeyGenParameterSpec.Builder(
                        alias,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                    )
                        .setKeySize(RSA_KEY_BITS)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_PKCS1)
                        .build(),
                )
            } else {
                val start = Calendar.getInstance()
                val end = Calendar.getInstance().apply { add(Calendar.YEAR, KEY_VALIDITY_YEARS) }
                @Suppress("DEPRECATION")
                val spec = KeyPairGeneratorSpec.Builder(appContext)
                    .setAlias(alias)
                    .setSubject(X500Principal("CN=Obaflix TV Session"))
                    .setSerialNumber(BigInteger.ONE)
                    .setStartDate(start.time)
                    .setEndDate(end.time)
                    .setKeySize(RSA_KEY_BITS)
                    .build()
                generator.initialize(spec)
            }
            generator.generateKeyPair()
        }

        private fun cifrar(nome: String, value: String, key: SecretKey): String {
            val cipher = Cipher.getInstance(AES_TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(nome.toByteArray(Charsets.UTF_8))
            val payload = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + SEPARATOR +
                Base64.encodeToString(payload, Base64.NO_WRAP)
        }

        private fun decifrar(nome: String, encoded: String, key: SecretKey): String {
            val parts = encoded.split(SEPARATOR, limit = 2)
            require(parts.size == 2) { "Envelope invalido" }
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val payload = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(AES_TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.updateAAD(nome.toByteArray(Charsets.UTF_8))
            return cipher.doFinal(payload).toString(Charsets.UTF_8)
        }

        private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply {
            load(null)
        }

        private fun invalidarMaterialCriptografico() {
            prefs.edit().clear().commit()
            aesCache = null
            runCatching {
                keyStore().apply {
                    if (containsAlias(alias)) deleteEntry(alias)
                }
            }
        }

        private companion object {
            const val ANDROID_KEYSTORE = "AndroidKeyStore"
            const val RSA_TRANSFORMATION = "RSA/ECB/PKCS1Padding"
            const val AES_TRANSFORMATION = "AES/GCM/NoPadding"
            const val CHAVE_AES_EMBRULHADA = "wrapped_aes"
            const val AES_KEY_BYTES = 32
            const val RSA_KEY_BITS = 2048
            const val GCM_TAG_BITS = 128
            const val KEY_VALIDITY_YEARS = 30
            const val SEPARATOR = "."
        }
    }

    private fun cofre(context: Context): Cofre {
        cache?.let { return it }
        synchronized(this) {
            cache?.let { return it }
            if (ObaflixApp.integrityStatus == AppIntegrityStatus.UNTRUSTED) {
                ObaLog.alerta(ObaLog.Fase.SESSAO, "sessao_volatil_apk_reassinado")
                return CofreMemoria().also { cache = it }
            }
            val criado = abrir(context.applicationContext)
            migrarTextoClaro(context.applicationContext, criado)
            cache = criado
            return criado
        }
    }

    private fun abrir(context: Context): Cofre {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            runCatching {
                val masterKey = MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()
                EncryptedSharedPreferences.create(
                    context,
                    ARQUIVO,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                )
            }.onSuccess { return CofrePreferences(it) }
                .onFailure {
                    ObaLog.alerta(
                        ObaLog.Fase.SESSAO,
                        "encrypted_prefs_indisponivel",
                        "erro" to it.javaClass.simpleName,
                    )
                }
        }

        return runCatching { CofreEnvelope(context).also { it.validar() } }
            .onSuccess {
                ObaLog.evento(
                    ObaLog.Fase.SESSAO,
                    "sessao_envelope",
                    "sdk" to Build.VERSION.SDK_INT,
                )
            }
            .getOrElse {
                ObaLog.alerta(
                    ObaLog.Fase.SESSAO,
                    "keystore_indisponivel_sessao_volatil",
                    "erro" to it.javaClass.simpleName,
                )
                CofreMemoria()
            }
    }

    /** Migra uma instalacao antiga e remove imediatamente o arquivo sem cifra. */
    private fun migrarTextoClaro(context: Context, destino: Cofre) {
        if (destino.ler(CHAVE_REFRESH) != null) return
        val antigo = context.getSharedPreferences(ARQUIVO_SIMPLES_ANTIGO, Context.MODE_PRIVATE)
        val refresh = antigo.getString(CHAVE_REFRESH, null) ?: return
        val device = antigo.getString(CHAVE_DEVICE, null).orEmpty()
        runCatching { destino.salvar(refresh, device) }
            .onSuccess {
                antigo.edit().clear().commit()
                ObaLog.evento(ObaLog.Fase.SESSAO, "sessao_migrada_para_cifra")
            }
    }

    fun refreshToken(context: Context): String? =
        runCatching { cofre(context).ler(CHAVE_REFRESH) }.getOrNull()

    fun deviceId(context: Context): String? =
        runCatching { cofre(context).ler(CHAVE_DEVICE) }.getOrNull()

    fun salvar(context: Context, refreshToken: String, deviceId: String) {
        runCatching { cofre(context).salvar(refreshToken, deviceId) }
            .onFailure {
                ObaLog.alerta(
                    ObaLog.Fase.SESSAO,
                    "sessao_nao_persistida",
                    "erro" to it.javaClass.simpleName,
                )
            }
    }

    /** Apaga credenciais persistidas e qualquer vestigio do formato antigo. */
    fun limpar(context: Context) {
        cofre(context).limpar()
        context.getSharedPreferences(ARQUIVO_SIMPLES_ANTIGO, Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
    }
}
