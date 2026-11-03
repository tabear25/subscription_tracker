import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "io.github.tabear25.subscriptionwidget"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.tabear25.subscriptionwidget"
        // ダイナミックカラー（Material You）とウィジェットの角丸・再設定がそろう Android 12 以上に限定する
        minSdk = 31
        targetSdk = 36
        versionCode = 2
        versionName = "1.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    packaging {
        // デバッグ版は dex を無圧縮で入れるため 30MB を超える。チャットで送れるサイズにするため圧縮して格納する
        dex {
            useLegacyPackaging = true
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.glance.appwidget)
    implementation(libs.work.runtime.ktx)
    implementation(libs.activity.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)

    testImplementation(libs.junit)
    // Android の org.json は単体テストでは中身の無いスタブになるため、本物を使う
    testImplementation(libs.org.json)
}
