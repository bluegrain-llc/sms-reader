import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
fun setting(name: String) = providers.gradleProperty(name).orElse(providers.environmentVariable(name)).getOrElse("")
fun quoted(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""
val publicKeys = listOf("RELAY_URL", "FIREBASE_APP_ID", "FIREBASE_API_KEY", "FIREBASE_PROJECT_ID", "FIREBASE_SENDER_ID", "GOOGLE_WEB_CLIENT_ID")
android {
    namespace = "com.bluegrain.smsrelay"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.bluegrain.smsrelay"
        minSdk = 26
        targetSdk = 36
        versionCode = 11
        versionName = "0.7.2"
        manifestPlaceholders["relayHost"] = runCatching { URI(setting("RELAY_URL")).host }.getOrNull() ?: "relay.invalid"
        manifestPlaceholders["relayScheme"] = "smsrelay"
        manifestPlaceholders["relayLabel"] = "Inbox"
        manifestPlaceholders["administrationLabel"] = "Administration"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "RELAY_LINK_SCHEME", quoted("smsrelay"))
        for (key in publicKeys) {
            buildConfigField("String", key, quoted(setting(key)))
        }
    }
    signingConfigs {
        create("pilot") {
            if (setting("RELAY_KEYSTORE").isNotBlank()) {
                storeFile = file(setting("RELAY_KEYSTORE"))
                storePassword = setting("RELAY_STORE_PASSWORD")
                keyAlias = setting("RELAY_KEY_ALIAS")
                keyPassword = setting("RELAY_KEY_PASSWORD")
            }
        }
        create("staging") {
            if (setting("STAGING_RELAY_KEYSTORE").isNotBlank()) {
                storeFile = file(setting("STAGING_RELAY_KEYSTORE"))
                storePassword = setting("STAGING_RELAY_STORE_PASSWORD")
                keyAlias = setting("STAGING_RELAY_KEY_ALIAS")
                keyPassword = setting("STAGING_RELAY_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("pilot")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        create("staging") {
            initWith(getByName("release"))
            applicationIdSuffix = ".staging"
            versionNameSuffix = "-staging"
            signingConfig = signingConfigs.getByName("staging")
            matchingFallbacks += listOf("release")
            manifestPlaceholders["relayHost"] = runCatching { URI(setting("STAGING_RELAY_URL")).host }.getOrNull() ?: "staging.relay.invalid"
            manifestPlaceholders["relayScheme"] = "smsrelay-staging"
            manifestPlaceholders["relayLabel"] = "Inbox staging"
            manifestPlaceholders["administrationLabel"] = "Administration staging"
            buildConfigField("String", "RELAY_LINK_SCHEME", quoted("smsrelay-staging"))
            for (key in publicKeys) buildConfigField("String", key, quoted(setting("STAGING_$key")))
        }
        create("stagingSetup") {
            initWith(getByName("staging"))
            isDebuggable = true
            isMinifyEnabled = false
            isShrinkResources = false
            versionNameSuffix = "-staging-setup"
            matchingFallbacks += listOf("staging", "release")
            manifestPlaceholders["relayLabel"] = "Inbox staging setup"
            manifestPlaceholders["administrationLabel"] = "Administration staging setup"
        }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
}
// Release builds cannot silently ship placeholders or an unsigned artifact.
tasks.configureEach {
    if (name in listOf("preReleaseBuild", "preStagingBuild", "preStagingSetupBuild")) doFirst {
        val prefix = if (name == "preReleaseBuild") "" else "STAGING_"
        // Validate the exact property-preferred values that BuildConfig will embed.
        val validation = ProcessBuilder("python3", rootProject.file("../scripts/release-config.py").absolutePath)
            .inheritIO().also { process ->
                publicKeys.forEach { process.environment()[it] = setting("$prefix$it") }
                process.environment()["ANDROID_PACKAGE_NAME"] = "com.bluegrain.smsrelay" + if (prefix.isEmpty()) "" else ".staging"
            }.start()
        require(validation.waitFor() == 0) { "Release configuration validation failed" }

        require(setting("${prefix}RELAY_URL").startsWith("https://")) { "Set HTTPS ${prefix}RELAY_URL" }
        for (key in listOf("FIREBASE_APP_ID", "FIREBASE_API_KEY", "FIREBASE_PROJECT_ID", "FIREBASE_SENDER_ID", "GOOGLE_WEB_CLIENT_ID", "RELAY_KEYSTORE", "RELAY_STORE_PASSWORD", "RELAY_KEY_ALIAS", "RELAY_KEY_PASSWORD")) {
            require(setting("$prefix$key").isNotBlank()) { "Missing release setting: $prefix$key" }
        }
    }
}
dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.11.00"))
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.5.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    implementation(platform("com.google.firebase:firebase-bom:34.5.0"))
    implementation("com.google.firebase:firebase-auth")
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.google.android.gms:play-services-auth-api-phone:18.2.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.work:work-runtime-ktx:2.10.5")
    implementation("org.commonmark:commonmark:0.32.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.11.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
