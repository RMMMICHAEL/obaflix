package com.nuvio.app.features.search

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChildCare
import androidx.compose.material.icons.outlined.FavoriteBorder
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.Pets
import androidx.compose.material.icons.outlined.Tv
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.nuvio.app.core.ui.NuvioDropdownChip
import com.nuvio.app.core.ui.NuvioDropdownOption
import com.nuvio.app.integration.obaflix.ObaflixDiscover

private val ObaflixRed = Color(0xFFE50914)

/**
 * Obaflix Search layout (reference: referencias/busca-referencia.png): category buttons under the
 * search bar, then "Descobrir" with Lançamentos / Gênero / Data. The grid below is Nuvio's.
 */
internal fun LazyListScope.obaflixDiscoverHeader(
    state: DiscoverUiState,
    onCatalogSelected: (String) -> Unit,
    onGenreSelected: (String?) -> Unit,
    onYearSelected: (String?) -> Unit,
) {
    val selection = ObaflixDiscover.parse(state.selectedCatalog?.catalogId)
    val category = selection?.first ?: ObaflixDiscover.categories.first()
    val sort = selection?.second ?: ObaflixDiscover.sorts.first()

    item(key = "obaflix_discover_categories") {
        // Opening Search lands on the reference default (Séries · Lançamentos).
        LaunchedEffect(selection == null) {
            if (selection == null) onCatalogSelected(ObaflixDiscover.optionKey(category, sort))
        }
        Row(
            modifier = Modifier
                .horizontalScroll(rememberScrollState())
                .padding(PaddingValues(horizontal = 16.dp)),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            ObaflixDiscover.categories.forEach { item ->
                ObaflixCategoryButton(
                    label = item.label,
                    icon = item.icon.vector(),
                    selected = item.key == category.key && selection != null,
                    onClick = { onCatalogSelected(ObaflixDiscover.optionKey(item, sort)) },
                )
            }
        }
        Spacer(Modifier.height(20.dp))
    }
    item(key = "obaflix_discover_title") {
        Text(
            text = "Descobrir",
            modifier = Modifier.padding(horizontal = 16.dp),
            style = MaterialTheme.typography.displaySmall,
            color = MaterialTheme.colorScheme.onBackground,
        )
    }
    item(key = "obaflix_discover_filters") {
        val selected = state.selectedCatalog
        Row(
            modifier = Modifier
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            NuvioDropdownChip(
                title = "Ordenar por",
                label = sort.label,
                selectedKey = sort.key,
                options = ObaflixDiscover.sorts.map { NuvioDropdownOption(key = it.key, label = it.label) },
                onSelected = { option ->
                    ObaflixDiscover.sorts.firstOrNull { it.key == option.key }
                        ?.let { onCatalogSelected(ObaflixDiscover.optionKey(category, it)) }
                },
            )
            NuvioDropdownChip(
                title = "Gênero",
                label = state.selectedGenre ?: "Gênero",
                selectedKey = state.selectedGenre ?: "",
                options = listOf(NuvioDropdownOption(key = "", label = "Todos os gêneros")) +
                    state.genreOptions.map { NuvioDropdownOption(key = it, label = it) },
                enabled = !category.fixedGenre && state.genreOptions.isNotEmpty(),
                onSelected = { onGenreSelected(it.key.ifBlank { null }) },
            )
            NuvioDropdownChip(
                title = "Data",
                label = state.selectedYear ?: "Data",
                selectedKey = state.selectedYear ?: "",
                options = listOf(NuvioDropdownOption(key = "", label = "Todas as datas")) +
                    selected?.yearOptions.orEmpty().map { NuvioDropdownOption(key = it, label = it) },
                enabled = selected?.yearOptions?.isNotEmpty() == true,
                onSelected = { onYearSelected(it.key.ifBlank { null }) },
            )
        }
    }
}

@Composable
private fun ObaflixCategoryButton(
    label: String,
    icon: ImageVector,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        modifier = Modifier
            .heightIn(min = 48.dp) // touch target
            .selectable(selected = selected, role = Role.Tab, onClick = onClick),
        shape = RoundedCornerShape(24.dp),
        color = if (selected) ObaflixRed.copy(alpha = 0.14f) else Color.White.copy(alpha = 0.06f),
        border = BorderStroke(
            width = if (selected) 2.dp else 1.dp,
            color = if (selected) ObaflixRed else Color.White.copy(alpha = 0.12f),
        ),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null, // the label already names it
                tint = if (selected) ObaflixRed else Color.White,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                text = label.uppercase(),
                color = Color.White,
                style = MaterialTheme.typography.labelLarge.copy(
                    fontWeight = FontWeight.SemiBold,
                    letterSpacing = 0.4.sp,
                ),
            )
        }
    }
}

private fun ObaflixDiscover.Icon.vector(): ImageVector = when (this) {
    ObaflixDiscover.Icon.TV -> Icons.Outlined.Tv
    ObaflixDiscover.Icon.FILM -> Icons.Outlined.Movie
    ObaflixDiscover.Icon.ANIME -> Icons.Outlined.Pets
    ObaflixDiscover.Icon.HEART -> Icons.Outlined.FavoriteBorder
    ObaflixDiscover.Icon.KIDS -> Icons.Outlined.ChildCare
}
