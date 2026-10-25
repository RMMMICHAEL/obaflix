package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.addons.AddonManifestParser
import com.nuvio.app.features.addons.buildAddonResourceUrl
import com.nuvio.app.features.catalog.buildCatalogUrl
import kotlinx.coroutines.test.runTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ObaflixSearchDiscoverTest {
    private val base = ObaflixConfig.BASE_URL
    private val manifestUrl = ObaflixConfig.CATALOG_ADDON_MANIFEST_URL
    private val requested = mutableListOf<String>()

    @BeforeTest
    fun setUp() {
        ObaflixCatalogAddon.clearCache()
        requested.clear()
        ObaflixCatalogAddon.fetch = { url -> requested += url.removePrefix(base); """{"filmes":[],"series":[]}""" }
    }

    @Test
    fun everyCategoryAndSortRoundTripsThroughItsCatalog() {
        ObaflixDiscover.categories.forEach { c ->
            ObaflixDiscover.sorts.forEach { s ->
                assertEquals(c to s, ObaflixDiscover.parse(ObaflixDiscover.catalogId(c, s)))
            }
        }
        assertNull(ObaflixDiscover.parse("obaflix.filmes.populares"))
        assertEquals(listOf("Séries", "Filmes", "Animes", "Doramas", "Kids"), ObaflixDiscover.categories.map { it.label })
        assertEquals(listOf("Lançamentos", "Populares", "Bem avaliados"), ObaflixDiscover.sorts.map { it.label })
    }

    @Test
    fun manifestOffersOptionalGenreAndYearOnDiscoverCatalogsOnly() {
        val manifest = AddonManifestParser.parse(manifestUrl, ObaflixCatalogAddon.manifest().toString())
        val filmes = manifest.catalogs.single { it.id == "obaflix.d.filmes.lancamentos" }
        assertTrue(filmes.extra.single { it.name == "year" }.let { !it.isRequired && "2024" in it.options })
        assertTrue(filmes.extra.single { it.name == "genre" }.let { !it.isRequired && "Terror" in it.options })
        assertTrue(manifest.catalogs.single { it.id == "obaflix.d.doramas.populares" }.extra.none { it.name == "genre" })
        assertTrue(manifest.catalogs.single { it.id == "obaflix.filmes.populares" }.extra.none { it.name == "year" })
        assertEquals(15, manifest.catalogs.count { it.id.startsWith(ObaflixDiscover.ID_PREFIX) })
    }

    @Test
    fun genreAndYearCombineIntoExistingApiParams() = runTest {
        val url = buildCatalogUrl(manifestUrl, "movie", "obaflix.d.filmes.populares", genre = "Terror", search = null, skip = 24, year = "2024")
        assertTrue(url.contains("year=2024"))
        ObaflixCatalogAddon.respond(url)
        assertEquals("/api/filmes?page=2&ordem=popular&genero=27&ano=2024", requested.last())

        ObaflixCatalogAddon.respond(buildAddonResourceUrl(manifestUrl, "catalog", "series", "obaflix.d.animes.nota", "year=2020"))
        assertEquals("/api/series?page=1&tipo=anime&ordem=nota&ano=2020", requested.last())

        // Doramas: genre is fixed by the category; a stray genre extra is not sent twice.
        ObaflixCatalogAddon.respond(buildAddonResourceUrl(manifestUrl, "catalog", "series", "obaflix.d.doramas.lancamentos", "genre=Comédia"))
        assertEquals("/api/series?page=1&tipo=serie&genero=18&idioma=ko,ja,zh,th&ordem=lancamento", requested.last())
    }
}
