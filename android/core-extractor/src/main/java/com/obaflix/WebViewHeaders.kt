package com.obaflix

import android.annotation.SuppressLint
import android.webkit.WebSettings
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import com.obaflix.bridge.ObaLog

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
// O lint marca REQUESTED_WITH_HEADER_ALLOW_LIST como RestrictedApi somente
// depois que este arquivo virou biblioteca: a checagem compara o groupId de
// quem chama, e modulo de app nao tinha um. A API e a mesma de antes.
@SuppressLint("RestrictedApi")
fun removerRequestedWithHeader(settings: WebSettings, origem: String) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
        ObaLog.alerta(ObaLog.Fase.SESSAO, "requested_with_nao_suportado", "origem" to origem)
        return
    }
    runCatching {
        WebSettingsCompat.setRequestedWithHeaderOriginAllowList(settings, emptySet())
    }.onSuccess {
        ObaLog.evento(ObaLog.Fase.SESSAO, "requested_with_desativado", "origem" to origem)
    }.onFailure { e ->
        ObaLog.alerta(ObaLog.Fase.SESSAO, "requested_with_falhou", "origem" to origem, "excecao" to e.javaClass.simpleName)
    }
}
