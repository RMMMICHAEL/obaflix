package com.nuvio.app.features.settings

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Policy
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import com.nuvio.app.core.ui.NuvioScreen
import com.nuvio.app.core.ui.NuvioScreenHeader
import com.nuvio.app.integration.obaflix.ObaflixConfig
import nuvio.composeapp.generated.resources.*
import org.jetbrains.compose.resources.stringResource

@Composable
fun LegalPrivacySettingsScreen(
    onBack: () -> Unit,
) {
    NuvioScreen(
        modifier = Modifier.fillMaxSize(),
    ) {
        stickyHeader {
            NuvioScreenHeader(
                title = stringResource(Res.string.compose_settings_page_legal_privacy),
                onBack = onBack,
            )
        }
        legalPrivacyContent(isTablet = false)
    }
}

/** Only the three real site pages: privacy policy, terms of use and the existing account-deletion flow. */
internal fun LazyListScope.legalPrivacyContent(
    isTablet: Boolean,
) {
    item {
        val uriHandler = LocalUriHandler.current
        SettingsGroup(isTablet = isTablet) {
            SettingsNavigationRow(
                title = stringResource(Res.string.compose_settings_page_privacy_policy),
                description = stringResource(Res.string.compose_settings_root_privacy_policy_description),
                icon = Icons.Rounded.Policy,
                isTablet = isTablet,
                onClick = { uriHandler.openUri(ObaflixConfig.PRIVACY_URL) },
            )
            SettingsGroupDivider(isTablet = isTablet)
            SettingsNavigationRow(
                title = stringResource(Res.string.compose_settings_page_terms),
                description = stringResource(Res.string.compose_settings_root_terms_description),
                icon = Icons.Rounded.Description,
                isTablet = isTablet,
                onClick = { uriHandler.openUri(ObaflixConfig.TERMS_URL) },
            )
            SettingsGroupDivider(isTablet = isTablet)
            SettingsNavigationRow(
                title = stringResource(Res.string.settings_account_delete_account),
                description = stringResource(Res.string.settings_account_delete_account_description),
                icon = Icons.Rounded.Delete,
                isTablet = isTablet,
                onClick = { uriHandler.openUri(ObaflixConfig.DELETE_ACCOUNT_URL) },
            )
        }
    }
}
