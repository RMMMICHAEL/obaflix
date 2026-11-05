package com.nuvio.app.integration.obaflix.ads

import android.app.AlertDialog
import android.app.Dialog
import androidx.activity.ComponentActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/**
 * Dismisses [dialogo] when this Activity is destroyed (rotation, theme/locale recreation, an ad taking over), so no window
 * stays attached to a dead Activity (WindowLeaked). [aoDestruir] lets the caller treat that as a cancellation.
 */
internal fun ComponentActivity.dispensarAoDestruir(dialogo: Dialog, aoDestruir: () -> Unit = {}) {
    lifecycle.addObserver(object : DefaultLifecycleObserver {
        override fun onDestroy(owner: LifecycleOwner) {
            runCatching { dialogo.dismiss() }
            aoDestruir()
            owner.lifecycle.removeObserver(this)
        }
    })
}

/** Yes/no question before an ad. False on cancel, back, or when the Activity goes away: an ad never opens unasked. */
internal suspend fun ComponentActivity.confirmarAnuncio(titulo: String, mensagem: String, positivo: String): Boolean =
    withContext(Dispatchers.Main) {
        if (isFinishing || isDestroyed) return@withContext false
        suspendCancellableCoroutine { cont ->
            fun responder(sim: Boolean) { if (cont.isActive) cont.resume(sim) }
            val dialogo = AlertDialog.Builder(this@confirmarAnuncio)
                .setTitle(titulo)
                .setMessage(mensagem)
                .setPositiveButton(positivo) { _, _ -> responder(true) }
                .setNegativeButton("Cancelar") { _, _ -> responder(false) }
                .setOnCancelListener { responder(false) }
                .create()
            dispensarAoDestruir(dialogo) { responder(false) }
            cont.invokeOnCancellation { runOnUiThread { runCatching { dialogo.dismiss() } } }
            dialogo.show()
        }
    }

/** Wording per purpose, kept in one place so playback, download and cast ask the same way. */
internal fun textoDoAnuncio(finalidade: String): String = when (finalidade) {
    "download" -> "o download"
    "transmissao" -> "a transmissão"
    else -> "a reprodução"
}
