package com.obaflix.tv.catalogo

/**
 * Modelos do catalogo.
 *
 * Sao os mesmos campos que o site ja publica; nada aqui e calculado no
 * aparelho a nao ser o que so a televisao usa (fracao de progresso, rotulo de
 * episodio). O que o backend nao devolve nao existe nesta tela — nenhuma
 * secao e inventada para preencher espaco.
 */

data class Genero(val id: Int, val nome: String)

data class Item(
    val id: String,
    val titulo: String,
    val poster: String?,
    val background: String?,
    val logo: String?,
    val sinopse: String?,
    val ano: Int?,
    val nota: Double?,
    /** "filme", "serie", "anime" ou "desenho". */
    val tipo: String,
    val generos: List<Genero> = emptyList(),
    /** Preenchidos so em Continuar Assistindo. */
    val progressoSeg: Int = 0,
    val duracaoSeg: Int? = null,
    val temporada: Int? = null,
    val numeroEp: Int? = null,
    val episodioId: String? = null,
) {
    /** Serie, anime e desenho compartilham a mesma rota e o mesmo player. */
    val ehSerie: Boolean get() = tipo != "filme"

    /** Fracao assistida, para a barrinha do card. Zero quando nao se aplica. */
    val progresso: Float
        get() = if (duracaoSeg != null && duracaoSeg > 0) {
            (progressoSeg.toFloat() / duracaoSeg).coerceIn(0f, 1f)
        } else 0f

    val rotuloEpisodio: String?
        get() = if (temporada != null && numeroEp != null) "T$temporada E$numeroEp" else null

    val chaveProgresso: String get() = episodioId ?: id
}

data class Fileira(
    /** Estavel entre recargas: e a chave de foco e de rolagem restaurada. */
    val id: String,
    val titulo: String,
    val itens: List<Item>,
    val paisagem: Boolean = false,
)

data class Home(val destaques: List<Item>, val fileiras: List<Fileira>)

data class Episodio(
    val id: String,
    val serieId: String,
    val temporada: Int,
    val numeroEp: Int,
    val titulo: String?,
    val thumbnail: String?,
    /**
     * Se ha alguma fonte cadastrada. O servidor manda "disponivel" ou null em
     * vez da URL — o aparelho nunca ve endereco de provedor no catalogo.
     */
    val disponivel: Boolean,
) {
    val rotulo: String get() = titulo?.takeIf { it.isNotBlank() } ?: "Episódio $numeroEp"
}

/** Ficha completa. `episodios` so vem preenchida para serie. */
data class Detalhe(
    val item: Item,
    val temporadas: List<Int>,
    val episodios: List<Episodio>,
) {
    fun episodiosDa(temporada: Int): List<Episodio> = episodios.filter { it.temporada == temporada }
}

/** Uma pagina de catalogo filtrado. */
data class Pagina(val itens: List<Item>, val pagina: Int, val paginas: Int) {
    val temMais: Boolean get() = pagina < paginas
}
