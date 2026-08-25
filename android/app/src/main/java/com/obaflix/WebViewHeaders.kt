package com.obaflix

import android.util.Log
import android.webkit.WebSettings
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

private const val TAG = "Obaflix"

/**
 * Garante que o header `X-Requested-With: com.obaflix` nao seja enviado.
 *
 * Provedores atras de Cloudflare tratam esse header como assinatura de WebView e
 * respondem com desafio (ou 403) mesmo quando o User-Agent ja foi limpo. Como o
 * header e injetado pela camada de rede DEPOIS de shouldInterceptRequest, ele nao
 * aparece em WebResourceRequest.requestHeaders e nao ha como remove-lo por
 * interceptacao — a unica alternativa seria refazer cada requisicao via OkHttp,
 * o que perderia corpos de POST e quebraria Range/streaming de midia.
 *
 * A API do androidx.webkit e uma allow-list de origens: o header so vai para as
 * origens listadas. Uma lista vazia significa "nunca enviar". Esse ja e o padrao
 * na WebView 118+, mas fixamos explicitamente para nao depender do padrao do
 * fabricante. Abaixo da 118 o recurso nao existe e o header continua indo — nao
 * ha fallback seguro, apenas log.
 */
fun removerRequestedWithHeader(settings: WebSettings, origem: String) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
        Log.w(TAG, "[header] WebView sem REQUESTED_WITH_HEADER_ALLOW_LIST — X-Requested-With pode ser enviado ($origem)")
        return
    }
    runCatching {
        WebSettingsCompat.setRequestedWithHeaderOriginAllowList(settings, emptySet())
    }.onSuccess {
        Log.d(TAG, "[header] X-Requested-With desativado ($origem)")
    }.onFailure { e ->
        Log.w(TAG, "[header] falha ao desativar X-Requested-With ($origem): ${e.javaClass.simpleName}")
    }
}
