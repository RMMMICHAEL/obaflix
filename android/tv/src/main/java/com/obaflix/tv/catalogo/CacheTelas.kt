package com.obaflix.tv.catalogo

/**
 * Cache em memoria das telas de aba.
 *
 * Existe por causa da correcao do crash de foco: a moldura deixou de ficar
 * composta sob a ficha/player (era o que criava o no desanexado que derrubava a
 * busca de foco). O efeito colateral seria recarregar Home e catalogo a cada
 * BACK — piscar "Carregando", perder a rolagem e o card de origem.
 *
 * Guardando os dados aqui, o retorno e instantaneo: a tela recompoe, le o que ja
 * estava carregado e a restauracao de foco devolve o cursor ao card. A rolagem
 * volta sozinha pelo estado saveable da LazyList. Nada disso e persistido em
 * disco — e so memoria de processo, descartada quando o app morre, e nao carrega
 * nenhum dado sensivel (so o catalogo publico que a Home ja mostrava).
 */
object CacheTelas {

    /** Home montada (destaques + fileiras). Null ate a primeira carga. */
    var home: Home? = null

    /** Estado de cada aba de catalogo, por nome de aba. */
    private val catalogo = HashMap<String, CatalogoCache>()

    fun catalogo(aba: String): CatalogoCache = catalogo.getOrPut(aba) { CatalogoCache() }

    /** Limpa tudo — chamado no logout, para a proxima conta nao herdar nada. */
    fun limpar() {
        home = null
        catalogo.clear()
    }
}

/** Snapshot de uma aba de catalogo, para o retorno nao refazer a consulta. */
class CatalogoCache {
    var itens: List<Item> = emptyList()
    var pagina: Int = 1
    var paginas: Int = 1
    var ordemOrdinal: Int = 0
    var generoId: Int? = null
    var generos: List<Genero> = emptyList()

    val vazio: Boolean get() = itens.isEmpty()
}
