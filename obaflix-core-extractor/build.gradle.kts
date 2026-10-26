// Obaflix core-extractor, copied from the official android/core-extractor (origin/main).
// Only the build script is new; sources are unchanged except `open class ObaflixApp`.
plugins {
    alias(libs.plugins.androidLibrary)
}

android {
    namespace = "com.obaflix.core"
    compileSdk = libs.versions.android.compileSdk.get().toInt()

    defaultConfig {
        minSdk = libs.versions.android.minSdk.get().toInt()
        buildConfigField("String", "OBAFLIX_URL", "\"https://obaflixbr.com\"")
        // Updater and signing pinning stay off in the lab: no manifest URL, no pinned certificates.
        buildConfigField("String", "UPDATE_MANIFEST_URL", "\"\"")
        buildConfigField("String", "ALLOWED_SIGNING_CERTS_SHA256", "\"\"")
        buildConfigField("boolean", "DIAG_LOGS", "false")
        buildConfigField("boolean", "PLAY_STORE_BUILD", "false")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    api("com.squareup.okhttp3:okhttp:4.12.0")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-android:${libs.versions.kotlinx.coroutines.get()}")
    api("androidx.webkit:webkit:1.12.1")
    // 2.5.3 (patch of the official 2.5.2): same API, native lib aligned to 16 KB pages.
    api("org.conscrypt:conscrypt-android:2.5.3")
    implementation("androidx.core:core-ktx:1.12.0")
}
