plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.lacaksmb.tracker"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.lacaksmb.tracker"
        // minSdk 26 (Android 8.0) per permintaan: dukungan Android 8 s/d 16.
        minSdk = 26
        targetSdk = 36
        versionCode = (project.findProperty("appVersionCode") as String?)?.toIntOrNull() ?: 1
        versionName = (project.findProperty("appVersionName") as String?) ?: "1.0.0"

        // Konfigurasi per-site ditanam SAAT BUILD lewat Gradle property
        // (-PsiteCode=... -PgatewayUrl=... -PsiteName=...), bukan diketik
        // staf saat pakai APK. Lihat scripts/build-for-site.sh — dipanggil
        // oleh backend-api saat admin memilih site di dashboard untuk
        // download APK. Default di bawah HANYA untuk build pengembangan
        // lokal (emulator Windows -> host via 10.0.2.2).
        buildConfigField(
            "String",
            "SITE_CODE",
            "\"${project.findProperty("siteCode") ?: "DEV-UNSET"}\"",
        )
        buildConfigField(
            "String",
            "GATEWAY_URL",
            "\"${project.findProperty("gatewayUrl") ?: "http://10.0.2.2:3333"}\"",
        )
        buildConfigField(
            "String",
            "SITE_NAME",
            "\"${project.findProperty("siteName") ?: "Development"}\"",
        )
        // backend-api (Laravel) — beda port dari GATEWAY_URL (realtime-gateway
        // AdonisJS). Dipakai LockOverlay untuk verifikasi OTP self-unlock
        // lewat POST /api/v1/device-otp/verify (endpoint publik, lihat
        // backend-api DeviceOtpController — tidak butuh login karena device
        // yang terkunci tidak bisa login).
        buildConfigField(
            "String",
            "BACKEND_API_URL",
            "\"${project.findProperty("backendApiUrl") ?: "http://10.0.2.2:8010/api/v1"}\"",
        )
        // Identitas device sendiri ditanam LANGSUNG saat build (-PdeviceUuid=...
        // -PdeviceSecret=...), BUKAN dibuat sendiri oleh app atau dipasangkan
        // belakangan lewat kode OTP -- backend-api membuat baris Device dulu
        // (dengan consent & nama yang sudah diisi admin), generate device_uuid
        // + device_secret di sana, lalu oper keduanya ke build ini (lihat
        // App\Services\ApkBuilder, App\Http\Controllers\Api\ApkBuildController
        // ::generate). Hasilnya: APK ini begitu dipasang LANGSUNG punya
        // identitas lengkap + device_secret yang sudah "dipasangkan" --
        // zero-touch, tidak ada layar pairing yang perlu diisi staf lapangan.
        // Kosong berarti build pengembangan lokal biasa (device_uuid dibuat
        // sendiri oleh app seperti sebelumnya, lihat DeviceIdentityStore).
        buildConfigField(
            "String",
            "DEVICE_UUID",
            "\"${project.findProperty("deviceUuid") ?: ""}\"",
        )
        buildConfigField(
            "String",
            "DEVICE_SECRET",
            "\"${project.findProperty("deviceSecret") ?: ""}\"",
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
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.okhttp)
    implementation(libs.socketio.client)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.datastore.preferences)
}
