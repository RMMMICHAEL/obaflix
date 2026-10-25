package com.nuvio.app.integration.obaflix

import android.content.Context
import com.nuvio.app.features.addons.AddonRepository
import com.nuvio.app.features.home.HomeRepository
import java.io.File

/** Public catalog JSON in the app cache dir (the OS may clear it; then Home just loads from the network). */
internal object ObaflixCatalogDiskCache : ObaflixDiskCache {
    private lateinit var dir: File

    fun install(context: Context) {
        dir = File(context.cacheDir, "obaflix_catalog")
        ObaflixCatalogAddon.disk = this
        // Fresh ranking arrived after the disk copy was shown: re-read Home rows (now all in memory).
        ObaflixCatalogAddon.onSharedRowsRefreshed = {
            HomeRepository.refresh(AddonRepository.uiState.value.addons)
        }
    }

    private fun file(key: String) = File(dir, key.trim('/').replace('/', '_') + ".json")

    override fun read(key: String): String? = runCatching { file(key).takeIf(File::isFile)?.readText() }.getOrNull()

    override fun ageMs(key: String): Long? =
        runCatching { file(key).takeIf(File::isFile)?.let { System.currentTimeMillis() - it.lastModified() } }.getOrNull()

    override fun write(key: String, value: String) {
        runCatching {
            dir.mkdirs()
            val tmp = File(dir, "${file(key).name}.tmp")
            tmp.writeText(value)
            tmp.renameTo(file(key)) // atomic swap: a crash never leaves half a ranking
            trim()
        }
    }

    /** Bounded store: oldest copies go first once there are too many files or bytes (they are only re-downloadable catalog JSON). */
    private fun trim() {
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }?.sortedBy(File::lastModified) ?: return
        var count = files.size
        var bytes = files.sumOf(File::length)
        for (f in files) {
            if (count <= MAX_FILES && bytes <= MAX_BYTES) break
            if (f.name == file("/api/tv/home").name) continue // the last Home is what offline cold starts show
            bytes -= f.length(); count--; f.delete()
        }
    }

    private const val MAX_FILES = 150
    private const val MAX_BYTES = 12L * 1024 * 1024
}
