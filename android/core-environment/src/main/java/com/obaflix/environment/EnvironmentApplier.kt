package com.obaflix.environment

import android.util.Log
import android.view.View
import android.webkit.WebView
import androidx.fragment.app.FragmentActivity

class EnvironmentApplier(
    private val activity: FragmentActivity,
    private val config: EnvironmentConfig
) {

    private val TAG = "ObaflixEnv"
    private val hiddenViews = mutableMapOf<String, View>()
    private val WEB_RETRY_COUNT = 40
    private val WEB_RETRY_DELAY_MS = 250L

    fun apply(env: EnvironmentState) {
        Log.d(TAG, "Aplicando regras. VPN=${env.isVpn} Emulador=${env.isEmulator} Regiao=${env.region}")

        val active = config.getActiveRules(env)
        Log.d(TAG, "Regras ativas: ${active.size}")

        for (rule in active) {
            Log.d(TAG, "Executando regra: ${rule.id} (${rule.action})")
            when (rule.action) {
                "hide" -> hide(rule.targets)
                "show" -> show(rule.targets)
                "disable" -> disable(rule.targets)
                "enable" -> enable(rule.targets)
                "replace" -> replace(rule.targets)
                else -> Log.w(TAG, "Acao desconhecida ignorada: ${rule.action}")
            }
        }
    }

    private fun jsStr(value: String): String =
        org.json.JSONObject.quote(value)

    /**
     * A WebView pode existir depois de setContentView(), mas o documento HTML/React
     * ainda pode estar carregando. O JS abaixo aguarda o documento e tenta novamente
     * por tempo limitado quando o target ainda nao existe.
     * O script informado deve retornar true quando a operacao foi aplicada e false
     * quando deve haver nova tentativa.
     */
    private fun runWebScriptWhenReady(webView: WebView, script: String) {
        val wrapped = """
            (function(){
                var tries = 0;
                function run(){
                    if(document.readyState === 'loading' && tries < $WEB_RETRY_COUNT){
                        tries++;
                        setTimeout(run, $WEB_RETRY_DELAY_MS);
                        return;
                    }
                    try{
                        var done = $script;
                        if(!done && tries < $WEB_RETRY_COUNT){
                            tries++;
                            setTimeout(run, $WEB_RETRY_DELAY_MS);
                        }
                    }catch(e){
                        console.warn('ObaflixEnv: falha ao aplicar regra', e);
                    }
                }
                run();
            })()
        """.trimIndent()
        webView.evaluateJavascript(wrapped, null)
    }

    private fun hide(targets: List<TargetSpec>) {
        for (t in targets) {
            val webView = findWebView()
            if (webView != null) {
                runWebScriptWhenReady(webView,
                    "(function(){var el=document.getElementById(${jsStr(t.id)});" +
                    "if(!el)return false;el.style.setProperty('display','none');return true;})()"
                )
                continue
            }
            val v = activity.findViewById<View>(resId(t.id))
            if (v != null) {
                v.visibility = View.GONE
                hiddenViews[t.id] = v
            } else {
                Log.w(TAG, "ID nao encontrado (hide): ${t.id}")
            }
        }
    }

    private fun show(targets: List<TargetSpec>) {
        for (t in targets) {
            val webView = findWebView()
            if (webView != null) {
                runWebScriptWhenReady(webView,
                    "(function(){var el=document.getElementById(${jsStr(t.id)});" +
                    "if(!el)return false;el.style.removeProperty('display');return true;})()"
                )
                continue
            }
            val v = hiddenViews[t.id] ?: activity.findViewById<View>(resId(t.id))
            if (v != null) {
                v.visibility = View.VISIBLE
                hiddenViews.remove(t.id)
            } else {
                Log.w(TAG, "ID nao encontrado (show): ${t.id}")
            }
        }
    }

    private fun disable(targets: List<TargetSpec>) {
        for (t in targets) {
            val webView = findWebView()
            if (webView != null) {
                runWebScriptWhenReady(webView,
                    "(function(){var el=document.getElementById(${jsStr(t.id)});" +
                    "if(!el)return false;el.setAttribute('disabled','true');return true;})()"
                )
                continue
            }
            val v = activity.findViewById<View>(resId(t.id))
            if (v != null) {
                v.isEnabled = false
            } else {
                Log.w(TAG, "ID nao encontrado (disable): ${t.id}")
            }
        }
    }

    private fun enable(targets: List<TargetSpec>) {
        for (t in targets) {
            val webView = findWebView()
            if (webView != null) {
                runWebScriptWhenReady(webView,
                    "(function(){var el=document.getElementById(${jsStr(t.id)});" +
                    "if(!el)return false;el.removeAttribute('disabled');return true;})()"
                )
                continue
            }
            val v = activity.findViewById<View>(resId(t.id))
            if (v != null) {
                v.isEnabled = true
            } else {
                Log.w(TAG, "ID nao encontrado (enable): ${t.id}")
            }
        }
    }

    private fun replace(targets: List<TargetSpec>) {
        for (t in targets) {
            val from = t.from
            val to = t.to
            if (from.isNullOrBlank() || to.isNullOrBlank()) {
                Log.w(TAG, "Replace sem from/to: ${t.id}")
                continue
            }

            val webView = findWebView()
            if (webView != null) {
                runWebScriptWhenReady(webView,
                    "(function(){" +
                    "var src=document.getElementById(${jsStr(from)});" +
                    "var dst=document.getElementById(${jsStr(to)});" +
                    "if(!src||!dst)return false;" +
                    "dst.innerHTML=src.innerHTML;return true;})()"
                )
            } else {
                val srcView = activity.findViewById<View>(resId(from))
                val dstView = activity.findViewById<View>(resId(to))
                if (srcView != null && dstView != null) {
                    dstView.visibility = srcView.visibility
                    dstView.isEnabled = srcView.isEnabled
                } else if (srcView == null) {
                    Log.w(TAG, "Replace: view 'from' nao encontrada: $from")
                } else {
                    Log.w(TAG, "Replace: view 'to' nao encontrada: $to")
                }
            }
        }
    }

    private fun findWebView(): WebView? {
        val webId = activity.resources.getIdentifier("webview", "id", activity.packageName)
        if (webId != 0) {
            val wv = activity.findViewById<WebView>(webId)
            if (wv != null) return wv
        }
        return findWebViewRecursive(activity.findViewById(android.R.id.content))
    }

    private fun findWebViewRecursive(view: View?): WebView? {
        if (view == null) return null
        if (view is WebView) return view
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                val found = findWebViewRecursive(view.getChildAt(i))
                if (found != null) return found
            }
        }
        return null
    }

    private fun resId(name: String): Int =
        activity.resources.getIdentifier(name, "id", activity.packageName)
}
