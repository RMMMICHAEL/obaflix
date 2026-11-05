package com.nuvio.app.integration.obaflix

import android.app.Application
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ObaflixDiskCacheBoundsTest {
    @Test
    fun storeStaysBoundedAndKeepsTheLastHome() {
        val context = RuntimeEnvironment.getApplication()
        ObaflixCatalogDiskCache.install(context)
        try {
            ObaflixCatalogDiskCache.write("/api/tv/home", "{}")
            repeat(170) { ObaflixCatalogDiskCache.write("/api/filmes/$it", "{}") }
            val files = context.cacheDir.resolve("obaflix_catalog").listFiles { f -> f.name.endsWith(".json") }!!
            assertTrue(files.size <= 150, "files=${files.size}")
            assertNotNull(ObaflixCatalogDiskCache.read("/api/tv/home"))
            assertNotNull(ObaflixCatalogDiskCache.ageMs("/api/tv/home"))
            assertNull(ObaflixCatalogDiskCache.ageMs("/api/filmes/none"))
        } finally {
            ObaflixCatalogAddon.disk = null
            ObaflixCatalogAddon.onSharedRowsRefreshed = null
        }
    }
}
