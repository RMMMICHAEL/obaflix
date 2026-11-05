package com.nuvio.app.features.updater

data class AppUpdate(
    val tag: String,
    val title: String,
    val notes: String,
    val releaseUrl: String?,
    val assetName: String,
    val assetUrl: String,
    val assetSizeBytes: Long?,
    val versionCode: Long? = null,
)


internal fun AppUpdate.isNewerThan(installedName: String, installedCode: Long?): Boolean =
    if (versionCode != null) installedCode != null && versionCode > installedCode
    else VersionUtils.isRemoteNewer(tag, installedName)

internal fun AppUpdate.shouldPrompt(force: Boolean, ignored: Boolean): Boolean =
    if (versionCode != null) force else force || !ignored
