package com.obaflix.tv.navegacao

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.toMutableStateList
import com.obaflix.tv.catalogo.Item
import com.obaflix.tv.player.Pedido

/**
 * As seis entradas do menu do topo.
 *
 * Cada uma existe porque o catalogo realmente a alimenta: Filmes vem de
 * /api/filmes; Series, Animes e Kids sao o mesmo /api/series com o campo
 * `tipo` que o banco ja guarda ("serie", "anime", "desenho"). Nenhuma aba foi
 * criada para preencher a barra — se o backend nao devolve, nao esta aqui.
 */
enum class Aba(val rotulo: String) {
    Inicio("INÍCIO"),
    Filmes("FILMES"),
    Series("SÉRIES"),
    Animes("ANIMES"),
    Kids("KIDS"),
    Busca("BUSCAR"),
}

/**
 * Telas empilhadas **sobre** a moldura de abas.
 *
 * Ficam como sobreposicao, e nao como substituicao, para que a Home continue
 * composta por baixo. E o que faz o retorno cair exatamente na fileira e no
 * card de onde a pessoa saiu: nada foi descartado, so ficou coberto. Recriar a
 * Home na volta obrigaria a restaurar rolagem e foco na mao — e, pior, a
 * recarregar o catalogo inteiro.
 */
sealed interface Camada {
    /**
     * Ficha do conteudo. `previa` e o card que originou a abertura: com ele a
     * arte de fundo e o titulo aparecem no mesmo quadro em que o OK foi
     * apertado, sem esperar a requisicao da ficha.
     */
    data class Detalhe(val id: String, val tipo: String, val previa: Item?) : Camada

    /** Reproducao em tela cheia. */
    data class Player(val pedido: Pedido) : Camada
}

/**
 * Estado de navegacao do aplicativo.
 *
 * Objeto unico e observavel, como a sessao. A alternativa — Navigation Compose
 * — traria um grafo, back stack proprio e recomposicao total da tela de origem
 * a cada volta; numa TV Box fraca isso aparece como um piscar de meio segundo
 * em cada BACK. Aqui BACK e uma remocao de lista.
 */
object Navegacao {

    var aba by mutableStateOf(Aba.Inicio)
        private set

    val pilha = emptyList<Camada>().toMutableStateList()

    /** Verdadeiro quando ha sobreposicao: a moldura de abas nao recebe foco. */
    val emCamada: Boolean get() = pilha.isNotEmpty()

    fun irPara(destino: Aba) {
        pilha.clear()
        aba = destino
    }

    fun abrir(camada: Camada) {
        pilha.add(camada)
    }

    /**
     * Abre a ficha de um item de catalogo.
     *
     * O tipo vem do proprio item porque serie, anime e desenho usam rotas
     * diferentes de filme — e um card de Continuar Assistindo pode ser
     * qualquer um dos quatro.
     */
    fun abrirDetalhe(item: Item) {
        abrir(Camada.Detalhe(item.id, item.tipo, item))
    }

    /** Retrocede uma camada. Devolve false quando ja estava na moldura. */
    fun voltar(): Boolean {
        if (pilha.isEmpty()) return false
        pilha.removeAt(pilha.lastIndex)
        return true
    }

    /** Fecha tudo. Usado quando a sessao cai no meio da navegacao. */
    fun limpar() {
        pilha.clear()
        aba = Aba.Inicio
    }
}
