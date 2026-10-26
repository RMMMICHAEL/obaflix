package com.nuvio.app.features.search

import android.app.Application
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.nuvio.app.core.ui.NuvioTheme
import com.nuvio.app.integration.obaflix.ObaflixDiscover
import org.junit.Rule
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.Test
import kotlin.test.assertEquals

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ObaflixSearchUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun searchShowsTheFiveCategoriesAndTheThreeDiscoverFilters() {
        val series = ObaflixDiscover.categories.first { it.key == "series" }
        val launches = ObaflixDiscover.sorts.first()
        val catalog = DiscoverCatalogOption(
            key = ObaflixDiscover.optionKey(series, launches),
            addonName = "Obaflix",
            manifestUrl = "https://obaflixbr.com/api/nuvio-addon/manifest.json",
            type = "series",
            catalogId = ObaflixDiscover.catalogId(series, launches),
            catalogName = launches.label,
            genreOptions = listOf("Drama"),
            yearOptions = listOf("2026", "2025"),
        )
        val state = DiscoverUiState(
            typeOptions = listOf("series"),
            selectedType = "series",
            catalogOptions = listOf(catalog),
            selectedCatalogKey = catalog.key,
        )
        val selected = mutableListOf<String>()

        compose.setContent {
            NuvioTheme {
                LazyColumn {
                    obaflixDiscoverHeader(
                        state = state,
                        onCatalogSelected = { selected += it },
                        onGenreSelected = {},
                        onYearSelected = {},
                    )
                }
            }
        }

        listOf("SÉRIES", "FILMES", "ANIMES", "DORAMAS").forEach { compose.onNodeWithText(it).assertIsDisplayed() }
        compose.onNodeWithText("Descobrir").assertIsDisplayed()
        listOf("Lançamentos", "Gênero", "Data").forEach { compose.onNodeWithText(it).assertIsDisplayed() }
        compose.onNodeWithText("SÉRIES", useUnmergedTree = true).assertExists()

        compose.onNodeWithText("FILMES").performClick()
        val filmes = ObaflixDiscover.categories.first { it.key == "filmes" }
        assertEquals(ObaflixDiscover.optionKey(filmes, launches), selected.last()) // keeps the current sort
    }
}
