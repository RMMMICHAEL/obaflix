package com.obaflix.ads

import android.app.Activity
import java.lang.ref.WeakReference

/**
 * [AdHost] apoiado numa Activity, sem segurar referencia forte.
 *
 * O interstitial da Unity abre uma Activity propria e devolve o controle por
 * callback. Entre o pedido e a callback o usuario pode sair do aplicativo,
 * girar a tela ou o sistema pode destruir a Activity — guardar referencia forte
 * aqui vazaria a tela inteira ate a callback chegar. Com [WeakReference], uma
 * callback tardia simplesmente encontra `null` e nao tenta iniciar nada em um
 * contexto invalido.
 */
class ActivityAdHost(activity: Activity) : AdHost {

    private val ref = WeakReference(activity)

    override val disponivel: Boolean
        get() = activity() != null

    /** A Activity viva, ou `null` se ja foi embora. */
    internal fun activity(): Activity? =
        ref.get()?.takeIf { !it.isFinishing && !it.isDestroyed }
}
