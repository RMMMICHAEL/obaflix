package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.addons.AddonManifestParser
import com.nuvio.app.features.addons.buildAddonResourceUrl
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ObaflixCatalogFiltersTest {
    private val base = ObaflixConfig.BASE_URL
    private val manifestUrl = ObaflixConfig.CATALOG_ADDON_MANIFEST_URL
    private val requested = mutableListOf<String>()
    private val api = mutableMapOf<String, String>()

    @BeforeTest
    fun setUp() {
        ObaflixCatalogAddon.clearCache()
        requested.clear()
        ObaflixCatalogAddon.fetch = { url -> requested += url.removePrefix(base); api[url.removePrefix(base)] ?: error("unexpected $url") }
    }

    private suspend fun metas(type: String, id: String, extra: String? = null) =
        Json.parseToJsonElement(ObaflixCatalogAddon.respond(buildAddonResourceUrl(manifestUrl, "catalog", type, id, extra)))
            .jsonObject["metas"]!!.jsonArray

    @Test
    fun manifestExposesGenreAndYearFiltersThroughTheGenreSelector() {
        val manifest = AddonManifestParser.parse(manifestUrl, ObaflixCatalogAddon.manifest().toString())
        val popular = manifest.catalogs.single { it.type == "movie" && it.id == "obaflix.filmes.populares" }
        val genre = popular.extra.single { it.name == "genre" }
        assertTrue("Terror" in genre.options && !genre.isRequired) // optional: also a Home row
        val byYear = manifest.catalogs.single { it.type == "series" && it.id == "obaflix.series.ano" }
            .extra.single { it.name == "genre" }
        assertTrue(byYear.isRequired && "2020" in byYear.options) // required: Discover only
        listOf("obaflix.animes.populares", "obaflix.kids", "obaflix.series.nota").forEach { id ->
            assertTrue(manifest.catalogs.any { it.type == "series" && it.id == id }, id)
        }
    }

    @Test
    fun filtersMapToExistingObaflixApiParams() = runTest {
        api["/api/filmes?page=2&ordem=nota&genero=27"] = """{"filmes":[{"id":"1","titulo":"A"}]}"""
        api["/api/series?page=1&tipo=anime&ordem=popular"] = """{"series":[{"id":"2","titulo":"B"}]}"""
        api["/api/series?page=1&tipo=serie&ordem=popular&ano=2020"] = """{"series":[{"id":"3","titulo":"C"}]}"""
        api["/api/filmes?page=1&ordem=popular&genero=16"] = """{"filmes":[{"id":"4","titulo":"D"}]}"""

        assertEquals("obaflix:filme:1", metas("movie", "obaflix.filmes.nota", "genre=Terror&skip=24")[0].jsonObject["id"]!!.jsonPrimitive.content)
        assertEquals(1, metas("series", "obaflix.animes.populares").size)
        assertEquals(1, metas("series", "obaflix.series.ano", "genre=2020").size)
        assertEquals(1, metas("movie", "obaflix.filmes.kids").size)
        // Unknown genre is ignored, not sent; "Por ano" without a year requests nothing.
        api["/api/filmes?page=1&ordem=popular"] = """{"filmes":[]}"""
        metas("movie", "obaflix.filmes.populares", "genre=Inexistente")
        assertEquals(0, metas("movie", "obaflix.filmes.ano").size)
        assertTrue(requested.none { "ano=" in it && "filmes" in it })
    }

    @Test
    fun seriesSimilarUsesObaflixRecommendationsWithoutTheTitleItself() = runTest {
        api["/api/series/7485/recomendacoes"] = """{"items":[{"id":"7485","titulo":"Mesma"},{"id":"9","titulo":"Outra","poster":"/p.jpg","ano":2020}]}"""
        val similar = ObaflixCatalogAddon.similar("obaflix:serie:7485")
        assertEquals(listOf("obaflix:serie:9"), similar.map { it.id })
        assertEquals("series", similar.single().type)
        assertEquals("https://image.tmdb.org/t/p/w500/p.jpg", similar.single().poster)
    }

    @Test
    fun movieSimilarFallsBackToPopularTitlesOfTheSameGenre() = runTest {
        api["/api/filmes/5"] = """{"id":"5","titulo":"Base","generos":[{"genero":{"id":27,"nome":"Terror"}}]}"""
        api["/api/filmes?page=1&ordem=popular&genero=27"] = """{"filmes":[{"id":"5","titulo":"Base"},{"id":"6","titulo":"Outro"}]}"""
        assertEquals(listOf("obaflix:filme:6"), ObaflixCatalogAddon.similar("obaflix:filme:5").map { it.id })
        // No genre: no guessing.
        api["/api/filmes/7"] = """{"id":"7","titulo":"Sem genero"}"""
        assertTrue(ObaflixCatalogAddon.similar("obaflix:filme:7").isEmpty())
    }
}
