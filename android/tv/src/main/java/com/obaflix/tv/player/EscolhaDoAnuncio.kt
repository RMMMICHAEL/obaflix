package com.obaflix.tv.player

/**
 * A escolha final do anuncio institucional: tres planos e "Continuar gratis"
 * sobre o ultimo quadro do video.
 *
 * ## Por que puro
 *
 * O D-pad aqui e explicito — cada seta tem destino declarado em
 * `focusProperties` (left/right/up/down), sem `enter` e sem busca 2D sobre
 * areas desenhadas por cima de um video. Separada da tela, a tabela de
 * vizinhos e testada em JVM.
 *
 * ```text
 * Basico ⇄ Plus ⇄ Premium          (nas pontas o cursor para)
 *    ↓       ↓       ↓
 *     Continuar gratis              (↑ volta ao ultimo plano focado)
 * ```
 */
enum class AlvoDaEscolha(
    /** Posicao do plano na vitrine de `TelaPlanos`; `null` para Continuar gratis. */
    val indiceDoPlano: Int?,
) {
    Basico(0),
    Plus(1),
    Premium(2),
    ContinuarGratis(null),
    ;

    val ehPlano: Boolean get() = indiceDoPlano != null
}

enum class DirecaoDpad { Esquerda, Direita, Cima, Baixo }

/** Onde o cursor nasce ao entrar na escolha final. */
val FOCO_INICIAL_DA_ESCOLHA = AlvoDaEscolha.Basico

/**
 * O vizinho de `alvo` na direcao pedida. Sem vizinho, o proprio alvo: o cursor
 * fica onde esta, nunca escapa da escolha.
 *
 * `ultimoPlano` e o plano focado por ultimo, para o UP a partir de Continuar
 * gratis; sem memoria (ou memoria invalida), Basico.
 */
fun vizinhoNaEscolha(alvo: AlvoDaEscolha, direcao: DirecaoDpad, ultimoPlano: AlvoDaEscolha?): AlvoDaEscolha =
    when (alvo) {
        AlvoDaEscolha.ContinuarGratis -> when (direcao) {
            DirecaoDpad.Cima -> ultimoPlano?.takeIf { it.ehPlano } ?: AlvoDaEscolha.Basico
            else -> alvo
        }
        else -> when (direcao) {
            DirecaoDpad.Baixo -> AlvoDaEscolha.ContinuarGratis
            DirecaoDpad.Cima -> alvo
            DirecaoDpad.Esquerda -> PLANOS_DA_ESCOLHA[(alvo.ordinal - 1).coerceAtLeast(0)]
            DirecaoDpad.Direita -> PLANOS_DA_ESCOLHA[(alvo.ordinal + 1).coerceAtMost(PLANOS_DA_ESCOLHA.lastIndex)]
        }
    }

private val PLANOS_DA_ESCOLHA = listOf(AlvoDaEscolha.Basico, AlvoDaEscolha.Plus, AlvoDaEscolha.Premium)

/** O que o OK faz em cada alvo. */
sealed interface AcaoDaEscolha {
    /** Abre Planos com o card destacado. Nao conclui nada nem libera nada. */
    data class AbrirPlanos(val indiceDoPlano: Int) : AcaoDaEscolha
    /** Envia `EscolheuContinuarGratis` a maquina de etapas. */
    data object ContinuarGratis : AcaoDaEscolha
}

fun acaoDoOk(alvo: AlvoDaEscolha): AcaoDaEscolha =
    alvo.indiceDoPlano?.let { AcaoDaEscolha.AbrirPlanos(it) } ?: AcaoDaEscolha.ContinuarGratis
