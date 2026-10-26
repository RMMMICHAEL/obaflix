package com.nuvio.app.integration.obaflix

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
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

    fun install(context: Context) {
        val app = context.applicationContext
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
