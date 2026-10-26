import java.util.Properties

fun readXcconfigValue(file: File, key: String): String? {
    if (!file.exists()) return null
    return file.readLines()
        .asSequence()
        .map(String::trim)
        .filter { it.isNotEmpty() && !it.startsWith("#") && it.contains('=') }
        .map { line ->
            val separatorIndex = line.indexOf('=')
            line.substring(0, separatorIndex).trim() to line.substring(separatorIndex + 1).trim()
        }
        .firstOrNull { (entryKey, _) -> entryKey == key }
        ?.second
}

plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeCompiler)
    alias(libs.plugins.sentry.android.gradle)
}

val localProps = Properties().apply {
    val propsFile = rootProject.file("local.properties")
    if (propsFile.exists()) propsFile.inputStream().use { load(it) }
}
// DEBUG-only Rewarded S2S homologation: `-PobaflixPreviewUrl=https://<name>.vercel.app` pins the whole app to that Vercel
// Preview (never production). Absent: a normal debug build. A malformed value fails the build instead of being ignored.
val obaflixPreviewUrl = (providers.gradleProperty("obaflixPreviewUrl").orNull ?: "").trim().trimEnd('/')
if (obaflixPreviewUrl.isNotEmpty()) {
    val host = obaflixPreviewUrl.removePrefix("https://")
    require(
        obaflixPreviewUrl.startsWith("https://") && host.endsWith(".vercel.app") && host.length > ".vercel.app".length &&
            host.none { it == '/' || it == ':' || it == '@' || it == '?' || it == '#' } && !host.contains("obaflix.online") && !host.contains("obaflixbr"),
    ) { "obaflixPreviewUrl must be https://<name>.vercel.app (a Preview origin, never production): '$obaflixPreviewUrl'" }
}

// Release Rewarded S2S: OFF unless the build is assembled with `-PobaflixRewardedRelease=true`. The default release (and the one
// published today) never carries it. Even when on, the server flags (ANUNCIO_REWARDED_PLAYER_ATIVO, LEVELPLAY_S2S_RECEIVER_ENABLED)
// must also be on for any ad to be requested, and the S2S confirmation stays mandatory.
val obaflixRewardedRelease = providers.gradleProperty("obaflixRewardedRelease").orNull?.trim() == "true"

// Release homologation with REAL ads: `-PobaflixHmlReal=true` (needs -PobaflixPreviewUrl and -PobaflixRewardedRelease=true). Own package,
// non-debuggable (real LevelPlay ads), whole app pinned to that Preview. Absent: no release build carries any Preview URL.
val obaflixHmlReal = providers.gradleProperty("obaflixHmlReal").orNull?.trim() == "true"

// Visual-homologation fixture for the Premium CTA/page (`-PobaflixPremiumDemo=true`). Never reaches the playstore flavor.
// External APK distribution (`-PobaflixExternalOfficial=true`, full flavor): official package + release key, updated by the legacy manifest.
val obaflixExternalOfficial = providers.gradleProperty("obaflixExternalOfficial").orNull?.trim() == "true"
val obaflixPremiumDemo = providers.gradleProperty("obaflixPremiumDemo").orNull?.trim() == "true"
if (obaflixHmlReal) {
    require(obaflixPreviewUrl.isNotEmpty() && obaflixRewardedRelease) {
        "obaflixHmlReal requires -PobaflixPreviewUrl=https://<name>.vercel.app and -PobaflixRewardedRelease=true"
    }
}

val releaseStoreFile = localProps.getProperty("NUVIO_RELEASE_STORE_FILE")?.takeIf { it.isNotBlank() }
val releaseStorePassword = localProps.getProperty("NUVIO_RELEASE_STORE_PASSWORD")?.takeIf { it.isNotBlank() }
val releaseKeyAlias = localProps.getProperty("NUVIO_RELEASE_KEY_ALIAS")?.takeIf { it.isNotBlank() }
val releaseKeyPassword = localProps.getProperty("NUVIO_RELEASE_KEY_PASSWORD")?.takeIf { it.isNotBlank() }
val releaseKeystore = releaseStoreFile?.let(rootProject::file)
fun envOrLocalProperty(key: String): String? =
    providers.environmentVariable(key).orNull?.trim()?.takeIf { it.isNotBlank() }
        ?: localProps.getProperty(key)?.trim()?.takeIf { it.isNotBlank() }

val sentryAuthToken = envOrLocalProperty("SENTRY_AUTH_TOKEN")
val sentryOrg = envOrLocalProperty("SENTRY_ORG")
val sentryProject = envOrLocalProperty("SENTRY_PROJECT")
val sentryMappingUploadEnabled = sentryAuthToken != null && sentryOrg != null && sentryProject != null
val appVersionConfigFile = rootProject.file("iosApp/Configuration/Version.xcconfig")
val releaseAppVersionName = providers.gradleProperty("nuvio.app.versionName").orNull
    ?: readXcconfigValue(appVersionConfigFile, "MARKETING_VERSION")
    ?: error("MARKETING_VERSION is missing from ${appVersionConfigFile.path}")
// Per-channel code from CI (`-PobaflixVersionCode=`): Play AAB and external APK must never share or lower a versionCode.
val releaseAppVersionCode = (providers.gradleProperty("obaflixVersionCode").orNull
    ?: readXcconfigValue(appVersionConfigFile, "CURRENT_PROJECT_VERSION"))
    ?.toIntOrNull()
    ?: error("CURRENT_PROJECT_VERSION is missing or invalid in ${appVersionConfigFile.path}")
val requestedTaskNames = gradle.startParameter.taskNames.map { it.substringAfterLast(':') }
val buildsReleaseApks = requestedTaskNames.any {
    it.startsWith("assemble", ignoreCase = true) && it.endsWith("Release", ignoreCase = true)
}

android {
    namespace = "com.nuvio.android"
    compileSdk = libs.versions.android.compileSdk.get().toInt()
    compileSdkMinor = libs.versions.android.compileSdkMinor.get().toInt()

    signingConfigs {
        create("release") {
            if (releaseKeystore != null && releaseStorePassword != null && releaseKeyAlias != null && releaseKeyPassword != null) {
                storeFile = releaseKeystore
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    defaultConfig {
        applicationId = "com.obaflix.nativelab" // lab package: never collides with the official com.obaflix
        minSdk = libs.versions.android.minSdk.get().toInt()
        targetSdk = libs.versions.android.targetSdk.get().toInt()
        versionCode = releaseAppVersionCode
        versionName = releaseAppVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Read only by the debug manifest (src/debug); the release manifest has no meta-data, so it never carries the URL.
        manifestPlaceholders["obaflixPreviewUrl"] = obaflixPreviewUrl
        manifestPlaceholders["obaflixRewardedRelease"] = obaflixRewardedRelease.toString()
        // Filled only for the release-homologation build; empty (ignored) in every other build.
        manifestPlaceholders["obaflixPreviewRelease"] = if (obaflixHmlReal) obaflixPreviewUrl else ""
        // Pix purchase stays off in the Google Play distribution (set true in the playstore flavor) until billing is regularized.
        manifestPlaceholders["obaflixPlayDistribution"] = "false"
        manifestPlaceholders["obaflixPremiumDemo"] = obaflixPremiumDemo.toString()
    }

    flavorDimensions += "distribution"
    productFlavors {
        create("full") {
            dimension = "distribution"
        }
        create("playstore") {
            dimension = "distribution"
            manifestPlaceholders["obaflixPlayDistribution"] = "true"
            manifestPlaceholders["obaflixPremiumDemo"] = "false" // no fixture in the Play distribution, whatever the flag
        }
    }

    sourceSets.getByName("full") {
        manifest.srcFile("src/full/AndroidManifest.xml")
        jniLibs.directories.add("../composeApp/src/full/jniLibs")
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
        jniLibs {
            useLegacyPackaging = true
            pickFirsts += listOf(
                "lib/*/libc++_shared.so",
                "lib/*/libavcodec.so",
                "lib/*/libavutil.so",
                "lib/*/libswscale.so",
                "lib/*/libswresample.so"
            )
        }
    }

    androidResources {
        noCompress += "cvr"
    }

    splits {
        abi {
            isEnable = buildsReleaseApks
            reset()
            include("armeabi-v7a", "arm64-v8a", "x86", "x86_64")
            isUniversalApk = false
        }
    }

    buildTypes {
        getByName("release") {
            val minifyRelease = providers.gradleProperty("releaseMinifyEnabled")
                .map(String::toBooleanStrict)
                .getOrElse(true)
            isMinifyEnabled = minifyRelease
            isShrinkResources = minifyRelease
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "../composeApp/proguard-rules.pro",
            )
            signingConfig = signingConfigs.getByName("release")
            ndk {
                debugSymbolLevel = "FULL"
            }
        }
    }

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        if (obaflixPreviewUrl.isEmpty()) {
            variant.applicationId.set("com.obaflix.nativelab.debug")
        } else {
            // Own package and version name: installs beside every other build and never replaces one of them.
            variant.applicationId.set("com.obaflix.nativelab.debug.rewardedhml")
            variant.outputs.forEach { out -> out.versionName.set("$releaseAppVersionName-rewarded-hml") }
        }
    }
}

androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        if (obaflixHmlReal) {
            variant.applicationId.set("com.obaflix.nativelab.hmlreal")
            variant.outputs.forEach { out -> out.versionName.set("$releaseAppVersionName-hml-real") }
        } else if (variant.flavorName == "playstore" || (variant.flavorName == "full" && obaflixExternalOfficial)) {
            // The official package: Play (playstore) or the external APK that replaces the legacy WebView app (full + flag).
            variant.applicationId.set("com.obaflix")
        }
    }
}

sentry {
    includeProguardMapping.set(true)
    autoUploadProguardMapping.set(sentryMappingUploadEnabled)
    uploadNativeSymbols.set(false)
    autoUploadNativeSymbols.set(false)
    includeNativeSources.set(false)
    includeSourceContext.set(false)
    autoUploadSourceContext.set(false)
    includeDependenciesReport.set(false)
    telemetry.set(false)
    sentryAuthToken?.let(authToken::set)
    sentryOrg?.let(org::set)
    sentryProject?.let(projectName::set)
    ignoredBuildTypes.set(setOf("debug"))
    autoInstallation {
        enabled.set(false)
    }
    tracingInstrumentation {
        enabled.set(false)
    }
}

dependencies {
    implementation(project(":composeApp"))
    implementation(libs.androidx.appcompat)
    implementation(libs.compose.runtime)
    coreLibraryDesugaring(libs.desugar.jdk.libs)
    debugImplementation(libs.compose.uiTooling)
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation(libs.androidx.testExt.junit)
    androidTestImplementation(libs.androidx.activity.compose)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4:${libs.versions.composeMultiplatform.get()}")
    debugImplementation("androidx.compose.ui:ui-test-manifest:${libs.versions.composeMultiplatform.get()}")
}
