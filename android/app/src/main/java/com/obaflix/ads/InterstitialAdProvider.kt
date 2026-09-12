package com.obaflix.ads

/**
 * O que a logica de negocio precisa saber sobre um interstitial — e nada alem.
 *
 * O SDK da Unity so aparece em [UnityInterstitialAdProvider]. Esta interface
 * fina existe para que a decisao (filme sempre, serie a cada N, Premium pula
 * tudo) seja testavel em JVM pura, com um duble, sem inicializar SDK nem
 * Activity.
 */
interface InterstitialAdProvider {

    /** Inicializa o SDK. Idempotente: chamar de novo nao reinicializa. */
    fun initialize()

    /** Ha um interstitial carregado e pronto para exibir agora? */
    val pronto: Boolean

    /**
     * Comeca a carregar o proximo interstitial, se ainda nao houver um
     * carregado nem um carregamento em andamento. Nunca bloqueia.
     */
    fun preload()

    /**
     * Exibe o interstitial carregado.
     *
     * [aoAbrir] e chamado **no maximo uma vez**, na thread principal, quando o
     * anuncio de fato cobre a tela (uma Activity/overlay do SDK ja esta na
     * frente). E o sinal de que, dali em diante, so o retorno do foco a nossa
     * Activity prova que a UI do anuncio foi realmente dispensada — o callback
     * terminal do SDK sozinho nao prova (pode chegar com o end-card ainda na
     * tela). Se a exibicao falhar **antes** de abrir, [aoAbrir] nunca e chamado,
     * e o gate pode liberar na hora (nao ha overlay sobreposto).
     *
     * Contrato que a implementacao **precisa** cumprir: [aoTerminar] e chamada
     * exatamente uma vez, na thread principal, aconteca o que acontecer —
     * anuncio concluido, fechado no X, falha de exibicao, host invalido ou
     * silencio do SDK. E o que garante que a reproducao nunca fique presa.
     */
    fun show(host: AdHost, aoAbrir: () -> Unit, aoTerminar: (AdShowOutcome) -> Unit)
}

/** Resultado de uma tentativa de exibicao. */
enum class AdShowOutcome {
    /** O anuncio apareceu na tela (concluido ou fechado pelo usuario). */
    EXIBIDO,

    /** Nada apareceu: falha, indisponibilidade ou host invalido. */
    NAO_EXIBIDO,
}

/**
 * Superficie onde o anuncio pode aparecer.
 *
 * Abstrato de proposito: a logica do gate nunca toca em `Activity`, e a
 * implementacao real ([ActivityAdHost]) guarda a referencia como fraca. Uma
 * callback tardia com a tela ja destruida ve `disponivel == false` e para ali.
 */
interface AdHost {
    /** A tela ainda existe e pode receber uma Activity de anuncio por cima? */
    val disponivel: Boolean
}
