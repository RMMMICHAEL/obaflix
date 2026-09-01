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
        set(valor) {
            field = valor
            homeEm = android.os.SystemClock.elapsedRealtime()
        }

    /**
     * Quando a Home foi montada, em relogio monotonico.
     *
     * Numa TV Box o aplicativo nao morre: fica aberto por dias. Sem marca de
     * tempo, o cache virava uma fotografia — "Continuar assistindo" mostrava o
     * que estava sendo visto na semana passada, enquanto o celular ja mostrava
     * outra coisa. Com a marca, a Home continua aparecendo na hora e revalida
     * por baixo.
     */
    var homeEm: Long = 0L
        private set

    /** Passou tempo demais desde a ultima carga da Home? */
    fun homeVelha(limiteMs: Long): Boolean =
        home == null || android.os.SystemClock.elapsedRealtime() - homeEm > limiteMs

    /** Estado de cada aba de catalogo, por nome de aba. */
    private val catalogo = HashMap<String, CatalogoCache>()

    fun catalogo(aba: String): CatalogoCache = catalogo.getOrPut(aba) { CatalogoCache() }

    /**
     * Esquece os filtros de uma aba ao sair dela.
     *
     * Escolher "2023" e "Aventura", ir para o Inicio e voltar trazia a aba
     * ainda filtrada, e era preciso desfazer a mao. Sair de uma aba passa a
     * significar sair do recorte: a proxima visita comeca no catalogo inteiro.
     *
     * So descarta quando havia filtro. Sem filtro, o cache fica e o retorno
     * continua instantaneo — nao ha por que pagar uma consulta para voltar a
     * mesma lista de sempre.
     */
    fun esquecerFiltros(aba: String) {
        val c = catalogo[aba] ?: return
        val filtrada = c.anoSel != null || c.generoId != null || c.ordemOrdinal != ORDEM_PADRAO
        if (filtrada) catalogo.remove(aba)
    }

    /** Limpa tudo — chamado no logout, para a proxima conta nao herdar nada. */
    fun limpar() {
        home = null
        catalogo.clear()
    }

    /** Ordinal de "Populares", o recorte que nao e recorte nenhum. */
    const val ORDEM_PADRAO = 1
}

/** Snapshot de uma aba de catalogo, para o retorno nao refazer a consulta. */
class CatalogoCache {
    var itens: List<Item> = emptyList()
    var pagina: Int = 1
    var paginas: Int = 1
    var ordemOrdinal: Int = CacheTelas.ORDEM_PADRAO
    var anoSel: Int? = null
    var generoId: Int? = null
    var generos: List<Genero> = emptyList()

    val vazio: Boolean get() = itens.isEmpty()
}
