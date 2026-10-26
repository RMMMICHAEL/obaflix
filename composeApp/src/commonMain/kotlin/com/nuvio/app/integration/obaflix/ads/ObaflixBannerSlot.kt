package com.nuvio.app.integration.obaflix.ads

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * Banner position. Takes no space until an ad is loaded, and nothing at all while ads are not
 * confirmed for the account. Never place it on the full-screen player.
 */
@Composable
expect fun ObaflixBannerSlot(modifier: Modifier = Modifier)
