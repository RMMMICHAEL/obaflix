package com.obaflix.ads

/**
 * Interruptor unico da publicidade do aplicativo movel.
 *
 * Tudo que decide "tem anuncio ou nao" passa por aqui — nenhuma tela, Activity
 * ou componente web consulta plano, assinatura ou estado de conta por conta
 * propria. Espalhar `if (premium)` pelas telas foi exatamente o que se evitou:
 * quando o Premium existir, o backend responde `ads=false`, alguem chama
 * [aplicarPlano] uma vez, e o mesmo [PlaybackAdGate] simplesmente pula toda a
 * publicidade sem que nenhuma tela saiba disso.
 *
 * Nesta etapa o valor e sempre `true`: nao ha assinatura, pagamento nem API de
 * planos, e nada le configuracao remota.
 */
object AdsConfig {

    @Volatile
    private var ads: Boolean = true

    /** Publicidade habilitada para este usuario? Padrao atual: sempre `true`. */
    val adsEnabled: Boolean
        get() = ads

    /**
     * Ponto de entrada do futuro Premium.
     *
     * Quando existir API de planos, a resposta do backend (`ads: false` para
     * assinante) chega aqui — e so aqui. Continua sem persistencia de proposito:
     * a fonte da verdade sera o backend, nao um arquivo local que um usuario
     * possa editar.
     */
    fun aplicarPlano(anunciosHabilitados: Boolean) {
        ads = anunciosHabilitados
    }
}
