package com.obaflix.tv.sessao

/**
 * Uma chamada autenticada que pode encontrar o access token vencido. Puro, sem
 * Android: testado em JVM.
 *
 * Tres desfechos que antes se confundiam num `null`:
 *
 *  - **Respondeu** — a chamada chegou ao servidor. Se o primeiro 401 era so o
 *    access token vencido (dura 15 min), a renovacao aconteceu e a chamada foi
 *    refeita uma vez. Nao ha terceira tentativa: um segundo 401 volta como
 *    resposta, e quem chamou trata como qualquer recusa daquele recurso.
 *  - **SessaoRecusada** — o servidor recusou o refresh (401 na renovacao):
 *    revogado, expirado, reutilizado ou de outro aparelho. Definitivo; a
 *    credencial local ja foi apagada e o app volta ao pareamento.
 *  - **RenovacaoAdiada** — o access venceu e nao deu para renovar agora (rede,
 *    timeout, 5xx, 429). A credencial fica; a proxima chamada tenta de novo.
 */
sealed interface DesfechoDaChamada<out R> {
    data class Respondeu<R>(val resposta: R, val renovou: Boolean) : DesfechoDaChamada<R>
    data object SessaoRecusada : DesfechoDaChamada<Nothing>
    data class RenovacaoAdiada(val motivo: String) : DesfechoDaChamada<Nothing>
}

suspend fun <R> executarComRenovacao(
    chamar: suspend () -> R,
    accessRecusado: (R) -> Boolean,
    renovar: suspend () -> ResultadoRenovacao,
): DesfechoDaChamada<R> {
    val primeira = chamar()
    if (!accessRecusado(primeira)) return DesfechoDaChamada.Respondeu(primeira, renovou = false)

    return when (val r = renovar()) {
        is ResultadoRenovacao.Renovado -> DesfechoDaChamada.Respondeu(chamar(), renovou = true)
        ResultadoRenovacao.Recusado -> DesfechoDaChamada.SessaoRecusada
        is ResultadoRenovacao.Temporario -> DesfechoDaChamada.RenovacaoAdiada(r.motivo)
    }
}
