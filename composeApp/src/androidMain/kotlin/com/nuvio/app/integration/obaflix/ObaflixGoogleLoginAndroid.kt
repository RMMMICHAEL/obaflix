package com.nuvio.app.integration.obaflix

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import java.lang.ref.WeakReference
import java.security.MessageDigest
import java.security.SecureRandom

/** Platform side of [ObaflixGoogleLogin]: S256 PKCE material and the system browser. */
internal object ObaflixGoogleLoginAndroid {
    private fun b64url(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    internal fun newPkce(random: SecureRandom = SecureRandom()): ObaflixGoogleLogin.Pkce {
        val verifier = b64url(ByteArray(32).also(random::nextBytes))
        val state = b64url(ByteArray(32).also(random::nextBytes))
        val challenge = b64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
        return ObaflixGoogleLogin.Pkce(verifier, challenge, state)
    }

    /** Account picker of the device (Credential Manager). Anything but a token or a dismissal means "use the browser". */
    private suspend fun pickAccount(activity: Activity?, nonce: String): ObaflixGoogleLogin.NativeResult {
        if (activity == null || activity.isFinishing) return ObaflixGoogleLogin.NativeResult.Unavailable
        return try {
            val option = GetGoogleIdOption.Builder()
                .setServerClientId(ObaflixConfig.GOOGLE_WEB_CLIENT_ID)
                .setFilterByAuthorizedAccounts(false)
                .setAutoSelectEnabled(false)
                .setNonce(nonce)
                .build()
            val result = CredentialManager.create(activity)
                .getCredential(activity, GetCredentialRequest.Builder().addCredentialOption(option).build())
            val credential = result.credential
            if (credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                ObaflixGoogleLogin.NativeResult.Token(GoogleIdTokenCredential.createFrom(credential.data).idToken)
            } else {
                ObaflixGoogleLogin.NativeResult.Unavailable
            }
        } catch (_: GetCredentialCancellationException) {
            ObaflixGoogleLogin.NativeResult.Cancelled
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            ObaflixGoogleLogin.NativeResult.Unavailable // no account, no OAuth client for this signing certificate, no Play services...
        }
    }

    fun install(context: Context) {
        val app = context.applicationContext
        val host = WeakReference(context as? Activity)
        ObaflixGoogleLogin.nativeIdToken = { nonce -> pickAccount(host.get(), nonce) }
        ObaflixGoogleLogin.newPkce = { newPkce() }
        ObaflixGoogleLogin.openBrowser = { url ->
            try {
                app.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                true
            } catch (_: ActivityNotFoundException) {
                false
            }
        }
    }
}
