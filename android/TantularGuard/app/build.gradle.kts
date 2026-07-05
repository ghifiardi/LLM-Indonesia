plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// On-device SLM native build is opt-in so the default build stays pure-Kotlin
// and works without the Android NDK or a llama.cpp checkout.
//   Enable with:  ./gradlew assembleDebug -PtantularNative=true
// Requires: scripts/fetch_llama_cpp.sh has populated app/src/main/cpp/llama.cpp
val tantularNative: Boolean =
    (project.findProperty("tantularNative") as String?)?.toBoolean() ?: false

android {
    namespace = "ai.sakana.tantularguard"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.sakana.tantularguard"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.3-guardian"

        if (tantularNative) {
            ndk {
                // 64-bit only: 3B models are not practical on 32-bit devices.
                abiFilters += listOf("arm64-v8a", "x86_64")
            }
            externalNativeBuild {
                cmake {
                    cppFlags += "-O3"
                    arguments += listOf(
                        "-DANDROID_STL=c++_shared",
                        "-DGGML_OPENMP=OFF",
                    )
                }
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        getByName("debug") {
            // Dev builds may use the remote Ollama dev-server SLM backend.
            buildConfigField("boolean", "ALLOW_DEV_SERVER", "true")
        }
        getByName("release") {
            // Production: on-device only. The remote dev-server SLM path is
            // compiled out of the UI so no message can leave the device via it.
            buildConfigField("boolean", "ALLOW_DEV_SERVER", "false")
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    if (tantularNative) {
        externalNativeBuild {
            cmake {
                path = file("src/main/cpp/CMakeLists.txt")
                version = "3.22.1"
            }
        }
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
