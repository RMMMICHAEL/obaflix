package com.nuvio.app.features.updater

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

object AndroidAppUpdaterPlatform {
    private const val preferencesName = "nuvio_updater"
    private const val ignoredTagKey = "ignored_release_tag"
    private const val updateChannelKey = "update_channel"

    private val httpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(60, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }

    private var appContext: Context? = null
    private val checkMutex = Mutex()
    private val cachedReleases = mutableMapOf<UpdateChannel, DirectApkUpdate?>()
    @Volatile private var availableRelease: DirectApkUpdate? = null
    @Volatile private var verifiedRelease: DirectApkUpdate? = null

    fun initialize(context: Context) {
        appContext = context.applicationContext
        AppUpdaterRepository.installedVersionCode = packageCode(installedPackage())
    }

    internal suspend fun fetchUpdate(channel: UpdateChannel): Result<AppUpdate> = withContext(Dispatchers.IO) {
        checkMutex.withLock {
            runCatching {
                availableRelease = null
                val url = DirectApkUpdateConfig.manifestUrl(channel)
                if (!isTrustedUpdateUrl(url, manifest = true)) throw NoChannelReleaseException()
                val now = System.currentTimeMillis()
                val key = "last_manifest_check_${channel.storedValue}"
                if (shouldCheckDirectUpdate(now, preferences().getLong(key, 0L))) {
                    preferences().edit().putLong(key, now).apply()
                    cachedReleases[channel] = null
                    val request = Request.Builder().url(url).header("Accept", "application/json")
                        .header("Cache-Control", "no-cache, no-store").build()
                    httpClient.newCall(request).execute().use { response ->
                        check(response.isSuccessful && response.request.url.isHttps) { "Não foi possível consultar a atualização" }
                        val body = requireNotNull(response.body) { "Manifesto de atualização vazio" }
                        val bytes = body.byteStream().use { input ->
                            val output = java.io.ByteArrayOutputStream()
                            val buffer = ByteArray(4096)
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val count = input.read(buffer)
                                if (count < 0) break
                                check(output.size() + count <= 65_536) { "Manifesto de atualização muito grande" }
                                output.write(buffer, 0, count)
                            }
                            output.toByteArray()
                        }
                        cachedReleases[channel] = parseDirectApkManifest(bytes.toString(Charsets.UTF_8))
                    }
                }
                val release = cachedReleases[channel] ?: throw NoChannelReleaseException()
                if (release.versionCode <= packageCode(installedPackage())) throw NoChannelReleaseException()
                availableRelease = release
                release.presentation()
            }.onFailure { if (it is CancellationException) throw it }
        }
    }

    fun getSupportedAbis(): List<String> = Build.SUPPORTED_ABIS?.toList().orEmpty()

    fun isDebugBuild(): Boolean {
        val context = appContext ?: return false
        return context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
    }

    fun getIgnoredTag(): String? =
        preferences().getString(ignoredTagKey, null)

    fun setIgnoredTag(tag: String?) {
        preferences().edit().apply {
            if (tag == null) remove(ignoredTagKey) else putString(ignoredTagKey, tag)
        }.apply()
    }

    fun getUpdateChannel(): String? = preferences().getString(updateChannelKey, null)

    fun setUpdateChannel(channel: String) {
        preferences().edit().putString(updateChannelKey, channel).apply()
    }

    fun deleteDownloadedApk(path: String) {
        if (File(path).canonicalFile == updateFile().canonicalFile) {
            verifiedRelease = null
            updateFile().delete()
        }
    }

    suspend fun downloadApk(
        assetUrl: String,
        assetName: String,
        onProgress: (downloadedBytes: Long, totalBytes: Long?) -> Unit,
    ): Result<String> = withContext(Dispatchers.IO) {
        val destination = runCatching { updateFile() }.getOrElse { return@withContext Result.failure(it) }
        var complete = false
        try {
            runCatching {
                val release = requireNotNull(availableRelease) { "Consulte o manifesto antes de baixar" }
                require(assetUrl == release.url && assetName == release.presentation().assetName && isTrustedUpdateUrl(assetUrl)) {
                    "APK não autorizado pelo manifesto"
                }
                verifiedRelease = null
                destination.parentFile?.mkdirs()
                destination.delete()
                val request = Request.Builder().url(assetUrl).build()
                httpClient.newCall(request).execute().use { response ->
                    check(response.isSuccessful && response.request.url.isHttps) { "Falha ao baixar atualização" }
                    val body = requireNotNull(response.body) { "APK vazio" }
                    val length = body.contentLength()
                    require(length < 0 || length == release.size) { "Tamanho HTTP do APK não confere" }
                    body.byteStream().use { input ->
                        FileOutputStream(destination).use { output ->
                            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                            var downloaded = 0L
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val count = input.read(buffer)
                                if (count < 0) break
                                downloaded += count
                                require(downloaded <= release.size) { "APK excedeu o tamanho do manifesto" }
                                output.write(buffer, 0, count)
                                onProgress(downloaded, release.size)
                            }
                        }
                    }
                }
                verifyApk(destination, release)
                verifiedRelease = release
                complete = true
                destination.absolutePath
            }.onFailure { if (it is CancellationException) throw it }
        } finally {
            if (!complete) destination.delete()
        }
    }

    fun canRequestPackageInstalls(): Boolean {
        val context = appContext ?: return false
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                context.packageManager.canRequestPackageInstalls()
            } catch (_: SecurityException) {
                false
            }
        } else {
            true
        }
    }

    fun openUnknownSourcesSettings() {
        val context = appContext ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    fun installDownloadedApk(path: String): Result<Unit> = runCatching {
        val context = requireContext()
        val apkFile = File(path)
        require(apkFile.canonicalFile == updateFile().canonicalFile) { "Caminho de APK inválido" }
        val release = requireNotNull(verifiedRelease) { "O APK ainda não foi validado" }
        verifyApk(apkFile, release)
        check(canRequestPackageInstalls()) { "Autorize a instalação nas configurações do Android" }

        val apkUri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            apkFile,
        )

        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(apkUri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        context.startActivity(intent)
    }

    private fun updateFile() = File(File(requireContext().cacheDir, "updates"), "obaflix-update.apk")

    @Suppress("DEPRECATION")
    private fun signatureFlags(): Int = if (Build.VERSION.SDK_INT >= 28) {
        PackageManager.GET_SIGNING_CERTIFICATES
    } else PackageManager.GET_SIGNATURES

    @Suppress("DEPRECATION")
    private fun installedPackage(): PackageInfo = requireContext().packageManager
        .getPackageInfo(requireContext().packageName, signatureFlags())

    @Suppress("DEPRECATION")
    private fun packageCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun currentSigners(info: PackageInfo): Set<String> =
        (if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures)
            ?.map { certificateSha256(it.toByteArray()) }?.toSet().orEmpty()

    @Suppress("DEPRECATION")
    private fun verifyApk(file: File, release: DirectApkUpdate) {
        verifyUpdateFile(file, release)
        val context = requireContext()
        val archive = requireNotNull(context.packageManager.getPackageArchiveInfo(file.absolutePath, signatureFlags())) {
            "APK inválido ou assinatura não reconhecida"
        }
        val installed = installedPackage()
        verifyUpdateIdentity(context.packageName, archive.packageName, packageCode(installed), packageCode(archive),
            release.versionCode, currentSigners(installed), currentSigners(archive))
    }

    private fun preferences() = requireContext().getSharedPreferences(preferencesName, Context.MODE_PRIVATE)

    private fun requireContext(): Context =
        requireNotNull(appContext) { "AndroidAppUpdaterPlatform.initialize must be called before use." }
}
