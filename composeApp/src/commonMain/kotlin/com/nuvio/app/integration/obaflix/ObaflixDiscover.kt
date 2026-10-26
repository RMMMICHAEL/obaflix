package com.nuvio.app.integration.obaflix

/**
 * Search screen "Descobrir": 5 categories x 3 sorts, each an Obaflix catalog with optional
 * genre/year extras. Discover-only (kept off Home by [ID_PREFIX]).
 */
object ObaflixDiscover {
    const val ID_PREFIX = "obaflix.d."
    const val MANIFEST_ID = "online.obaflix.catalog"

    enum class Icon { TV, FILM, ANIME, HEART, KIDS }

    data class Category(
        val key: String,
        val label: String,
        val type: String,
        val query: String,
        val icon: Icon,
        /** The category already fixes the genre, so the "Gênero" filter is off. */
        val fixedGenre: Boolean = false,
    )

    data class Sort(val key: String, val label: String, val query: String)

    val categories = listOf(
        Category("series", "Séries", "series", "&tipo=serie", Icon.TV),
        Category("filmes", "Filmes", "movie", "", Icon.FILM),
        Category("animes", "Animes", "series", "&tipo=anime", Icon.ANIME),
        // shortcut: the API has no "dorama" type nor language filter; Drama series until
        // /api/series honours idioma=ko,ja,zh,th (sent already, ignored today).
        Category("doramas", "Doramas", "series", "&tipo=serie&genero=18&idioma=ko,ja,zh,th", Icon.HEART, fixedGenre = true),
        Category("kids", "Kids", "series", "&tipo=desenho", Icon.KIDS),
    )

    val sorts = listOf(
        Sort("lancamentos", "Lançamentos", "&ordem=lancamento"),
        Sort("populares", "Populares", "&ordem=popular"),
        Sort("nota", "Bem avaliados", "&ordem=nota"),
    )

    fun catalogId(category: Category, sort: Sort) = "$ID_PREFIX${category.key}.${sort.key}"

    /** Key of the matching Discover option (SearchRepository builds "<manifest>:<type>:<catalog>"). */
    fun optionKey(category: Category, sort: Sort) = "$MANIFEST_ID:${category.type}:${catalogId(category, sort)}"

    /** Category and sort of a selected catalog id, or null when it is not an Obaflix Discover catalog. */
    fun parse(catalogId: String?): Pair<Category, Sort>? {
        val rest = catalogId?.removePrefix(ID_PREFIX)?.takeIf { it != catalogId } ?: return null
        val category = categories.firstOrNull { rest.startsWith("${it.key}.") } ?: return null
        val sort = sorts.firstOrNull { it.key == rest.removePrefix("${category.key}.") } ?: return null
        return category to sort
    }
}
