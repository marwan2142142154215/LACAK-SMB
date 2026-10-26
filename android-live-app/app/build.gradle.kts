plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.lacaksmb.live"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.lacaksmb.live"
        // minSdk 26 (Android 8.0) — sama seperti APK Master & APK Lacak.
        minSdk = 26
        targetSdk = 36
        versionCode = (project.findProperty("appVersionCode") as String?)?.toIntOrNull() ?: 1
        versionName = (project.findProperty("appVersionName") as String?) ?: "1.0.0"

        // Hanya HP ARM (semua HP Android staf); x86 hanya emulator. Library
        // native WebRTC + ML Kit untuk 4 ABI membuat APK >100 MB.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }

        // URL backend-api ditanam saat build (pola sama dengan APK Master).
        // Alamat LiveKit TIDAK ditanam -- datang dari respons
        // /live/sessions/start (livekit_url), jadi ikut konfigurasi server.
        buildConfigField(
            "String",
            "BACKEND_API_URL",
            "\"${project.findProperty("backendApiUrl") ?: "http://10.0.2.2:8000/api/v1"}\"",
        )
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.security.crypto)
    implementation(libs.livekit.android)
    implementation(libs.mlkit.face.detection)
}
