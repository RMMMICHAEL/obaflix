package com.obaflix.environment

import android.view.View
import androidx.fragment.app.FragmentActivity

class EnvironmentApplier(
    private val activity: FragmentActivity,
    private val config: EnvironmentConfig
) {

    private val hiddenViews = mutableMapOf<String, View>()

    fun apply(env: EnvironmentState) {
        val active = config.getActiveRules(env)
        for (rule in active) {
            when (rule.action) {
                "hide" -> hide(rule.targets)
                "show" -> show(rule.targets)
                "disable" -> disable(rule.targets)
                "enable" -> enable(rule.targets)
                "replace" -> replace(rule.targets)
            }
        }
    }

    private fun hide(targets: List<String>) {
        for (t in targets) {
            val v = activity.findViewById<View>(resId(t))
            if (v != null) { v.visibility = View.GONE; hiddenViews[t] = v }
        }
    }

    private fun show(targets: List<String>) {
        for (t in targets) {
            val v = hiddenViews[t] ?: activity.findViewById<View>(resId(t))
            if (v != null) { v.visibility = View.VISIBLE; hiddenViews.remove(t) }
        }
    }

    private fun disable(targets: List<String>) {
        for (t in targets) {
            activity.findViewById<View>(resId(t))?.isEnabled = false
        }
    }

    private fun enable(targets: List<String>) {
        for (t in targets) {
            activity.findViewById<View>(resId(t))?.isEnabled = true
        }
    }

    private fun replace(targets: List<String>) {
        // Substituicao de layouts conforme IDs reais do app
        // Implementar quando os IDs reais forem confirmados
    }

    private fun resId(name: String): Int =
        activity.resources.getIdentifier(name, "id", activity.packageName)
}