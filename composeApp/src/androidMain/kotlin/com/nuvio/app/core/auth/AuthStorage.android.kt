package com.nuvio.app.core.auth

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

actual object AuthStorage {
    private const val PREFS_NAME = "nuvio_auth"
    private const val KEY_ANONYMOUS_USER_ID = "anonymous_user_id"
    private const val KEY_OBAFLIX_SESSION_LEGACY = "obaflix_session" // plaintext, read once to migrate
    private const val KEY_OBAFLIX_SESSION = "obaflix_session_enc"
    private const val KEY_DATA_OWNER = "data_owner_user_id"
    private const val KEY_ALIAS = "com.obaflix.nativelab.session.v1"

    private var preferences: SharedPreferences? = null
    private val lock = Any()

    /** Replaced in tests; production uses the Android Keystore. */
    internal var secretKey: () -> SecretKey = ::keystoreKey

    fun initialize(context: Context) {
        preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    actual fun loadAnonymousUserId(): String? =
        preferences?.getString(KEY_ANONYMOUS_USER_ID, null)

    actual fun saveAnonymousUserId(userId: String) {
        preferences?.edit()?.putString(KEY_ANONYMOUS_USER_ID, userId)?.apply()
    }

    actual fun clearAnonymousUserId() {
        preferences?.edit()?.remove(KEY_ANONYMOUS_USER_ID)?.apply()
    }

    /**
     * The session cookie is stored AES-GCM encrypted with a non-exportable Keystore key. Anything
     * unreadable (corrupt, tampered, key gone) is dropped, so the user just signs in again; profiles,
     * history, lists and cache live elsewhere and are never touched.
     */
    actual fun loadObaflixSession(): String? = synchronized(lock) {
        val prefs = preferences ?: return@synchronized null
        prefs.getString(KEY_OBAFLIX_SESSION, null)?.let { stored ->
            return@synchronized runCatching { decrypt(stored) }.getOrNull()
                ?: run { prefs.edit().remove(KEY_OBAFLIX_SESSION).commit(); null }
        }
        // Existing installs: move the plaintext cookie into the encrypted slot, then erase it.
        val legacy = prefs.getString(KEY_OBAFLIX_SESSION_LEGACY, null) ?: return@synchronized null
        val migrated = runCatching { encrypt(legacy) }.getOrNull()
        val edit = prefs.edit().remove(KEY_OBAFLIX_SESSION_LEGACY)
        if (migrated != null) edit.putString(KEY_OBAFLIX_SESSION, migrated)
        edit.commit()
        if (migrated != null) legacy else null // no usable key: plaintext erased, sign in again
    }

    actual fun saveObaflixSession(payload: String) {
        synchronized(lock) {
            val prefs = preferences ?: return
            // No usable key: the session lives in memory only until the next start (then: sign in again).
            val encrypted = runCatching { encrypt(payload) }.getOrNull()
            val edit = prefs.edit().remove(KEY_OBAFLIX_SESSION_LEGACY)
            if (encrypted != null) edit.putString(KEY_OBAFLIX_SESSION, encrypted) else edit.remove(KEY_OBAFLIX_SESSION)
            edit.commit()
        }
    }

    actual fun clearObaflixSession() {
        synchronized(lock) {
            preferences?.edit()?.remove(KEY_OBAFLIX_SESSION)?.remove(KEY_OBAFLIX_SESSION_LEGACY)?.commit()
        }
    }

    // Account that owns the per-profile data on this device; survives sign-out and 401.
    actual fun loadDataOwner(): String? =
        preferences?.getString(KEY_DATA_OWNER, null)

    actual fun saveDataOwner(userId: String) {
        preferences?.edit()?.putString(KEY_DATA_OWNER, userId)?.apply()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        cipher.updateAAD(AAD)
        val data = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return "${b64(cipher.iv)}.${b64(data)}"
    }

    private fun decrypt(stored: String): String {
        val parts = stored.split('.', limit = 2)
        require(parts.size == 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
        cipher.updateAAD(AAD)
        return cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)).toString(Charsets.UTF_8)
    }

    private fun b64(value: ByteArray) = Base64.encodeToString(value, Base64.NO_WRAP)

    private val AAD = "$KEY_ALIAS:$KEY_OBAFLIX_SESSION".toByteArray(Charsets.UTF_8)

    private fun keystoreKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }
}
