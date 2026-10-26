package com.nuvio.app.features.settings

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.draw.shadow
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import nuvio.composeapp.generated.resources.Res
import nuvio.composeapp.generated.resources.obaflix_mark
import org.jetbrains.compose.resources.painterResource

@Composable
internal fun AppBrandWordmark(
    modifier: Modifier = Modifier,
    contentDescription: String? = null,
    contentColor: Color = MaterialTheme.colorScheme.onSurface,
) {
    Row(
        modifier = Modifier.heightIn(max = 36.dp).then(modifier).semantics(mergeDescendants = true) {
            if (contentDescription != null) this.contentDescription = contentDescription
        },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Image(
            painter = painterResource(Res.drawable.obaflix_mark),
            contentDescription = null,
            modifier = Modifier.size(28.dp),
            contentScale = ContentScale.Fit,
        )
        Text(
            text = buildAnnotatedString {
                withStyle(SpanStyle(color = Color(0xFFDC2626))) { append("OBA") }
                append("FLIX")
            },
            color = contentColor,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Black,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
    }
}

/** The Obaflix mark alone (Electron identity): one per area, e.g. Home top bar or player toolbar. */
@Composable
internal fun ObaflixMark(
    modifier: Modifier = Modifier,
    contentDescription: String? = null,
) {
    Image(
        painter = painterResource(Res.drawable.obaflix_mark),
        contentDescription = contentDescription,
        modifier = modifier,
        contentScale = ContentScale.Fit,
    )
}

/** Bottom-bar center mark: the Obaflix icon in a dark circle with a soft magenta rim and glow. */
@Composable
internal fun ObaflixNavMark(modifier: Modifier = Modifier) {
    val magenta = Color(0xFFE0168C)
    ObaflixMark(
        contentDescription = "Obaflix",
        modifier = modifier
            .shadow(10.dp, CircleShape, ambientColor = magenta, spotColor = magenta)
            .background(Brush.radialGradient(listOf(Color(0xFF2A0F22), Color(0xFF0E0A10))), CircleShape)
            .border(1.dp, Brush.verticalGradient(listOf(magenta.copy(alpha = 0.55f), magenta.copy(alpha = 0.12f))), CircleShape)
            .padding(5.dp),
    )
}
