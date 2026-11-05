package com.nuvio.app.core.build

actual object AppFeaturePolicy {
    actual val pluginsEnabled: Boolean = false
    actual val supportersContributorsPageEnabled: Boolean = false // Nuvio community/Patreon, not Obaflix
    actual val donationActionsEnabled: Boolean = false
    actual val donationProgressEnabled: Boolean = false
    actual val accountDeletionEnabled: Boolean = false // Nuvio cloud account; Obaflix deletion is obaflixbr.com/excluir-conta
    actual val personalMediaAddonCopyEnabled: Boolean = false
    actual val p2pEnabled: Boolean = false // P2P/torrent streaming is not offered by Obaflix on Google Play
    actual val trailerPlaybackMode: TrailerPlaybackMode = TrailerPlaybackMode.EXTERNAL
    actual val heroTrailerPlaybackSupported: Boolean = false
    actual val inAppUpdaterEnabled: Boolean = false
    actual val imdbRatingLogoEnabled: Boolean = false
    actual val mediaPlaybackForegroundServiceEnabled: Boolean = false
    actual val downloadForegroundServiceEnabled: Boolean = false
    actual val customServerConnectionsEnabled: Boolean = false
}
