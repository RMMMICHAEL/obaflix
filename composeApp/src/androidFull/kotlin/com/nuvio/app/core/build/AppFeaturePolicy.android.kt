package com.nuvio.app.core.build

// Obaflix fork: no Nuvio updater/donations/custom servers; no P2P or JS scraper plugins (not required, larger attack surface).
actual object AppFeaturePolicy {
    actual val pluginsEnabled: Boolean = false
    actual val supportersContributorsPageEnabled: Boolean = false
    actual val donationActionsEnabled: Boolean = false
    actual val donationProgressEnabled: Boolean = false
    actual val accountDeletionEnabled: Boolean = false
    actual val personalMediaAddonCopyEnabled: Boolean = false
    actual val p2pEnabled: Boolean = false
    actual val trailerPlaybackMode: TrailerPlaybackMode = TrailerPlaybackMode.IN_APP
    actual val heroTrailerPlaybackSupported: Boolean = true
    actual val inAppUpdaterEnabled: Boolean = false
    actual val imdbRatingLogoEnabled: Boolean = true
    actual val mediaPlaybackForegroundServiceEnabled: Boolean = true
    actual val downloadForegroundServiceEnabled: Boolean = true
    actual val customServerConnectionsEnabled: Boolean = false
}
