import groovy.json.JsonSlurper
import java.util.Properties
import javax.inject.Inject
import org.gradle.internal.os.OperatingSystem

plugins {
    id("com.android.application")
}

// 版本号与桌面版共用 package.json
val repoRoot: File = rootDir.parentFile
// -PlavaVersion=x.y.z 只用于测试应用内升级（打一个「更新的」包）
val pkgVersion = (findProperty("lavaVersion") as String?) ?: (JsonSlurper().parse(repoRoot.resolve("package.json")) as Map<*, *>)["version"] as String
val (vMajor, vMinor, vPatch) = pkgVersion.split(".").map { it.takeWhile(Char::isDigit).toInt() }
// 打正式版时按 CPU 架构分别出包；调试版一个包同时带手机（arm64）和模拟器（x86_64）的库
val releaseBuild = gradle.startParameter.taskNames.any { it.contains("Release", ignoreCase = true) }

// 正式签名：android/keystore.properties（不进仓库）指向仓库外的密钥文件。应用内更新要求每个版本签名相同，密钥务必备份
val keystore = rootDir.resolve("keystore.properties").takeIf { it.exists() }?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }

android {
    namespace = "com.lavatranslate.app"
    compileSdk = 37

    signingConfigs {
        if (keystore != null) create("release") {
            storeFile = file(keystore.getProperty("storeFile"))
            storePassword = keystore.getProperty("storePassword")
            keyAlias = keystore.getProperty("keyAlias")
            keyPassword = keystore.getProperty("keyPassword")
        }
    }

    defaultConfig {
        applicationId = "com.lavatranslate.app"
        minSdk = 29
        targetSdk = 37
        versionCode = vMajor * 10000 + vMinor * 100 + vPatch
        versionName = pkgVersion
        if (!releaseBuild) ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // 没有正式签名时退回调试签名（只能自己装，不能应用内升级到正式版）
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // 正式版：手机装 arm64-v8a 那个（约一半大小）；x86_64 给模拟器
    splits {
        abi {
            isEnable = releaseBuild
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }

    buildFeatures { buildConfig = true }

    // 模型直接从 APK 里映射读取，不压缩
    androidResources { noCompress += listOf("onnx") }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("androidx.dynamicanimation:dynamicanimation:1.1.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.30.0")
}

// ---------------------------------------------------------------- 网页界面与 OCR 模型
// 手机版界面（src/mobile）由 vite 构建到 out/mobile；OCR 模型与桌面版共用 resources/models（npm run models 下载）
val buildWeb by tasks.registering(Exec::class) {
    workingDir = repoRoot
    val npm = if (OperatingSystem.current().isWindows) listOf("cmd", "/c", "npm") else listOf("npm")
    commandLine(npm + listOf("run", "build:mobile"))
    inputs.dir(repoRoot.resolve("src/mobile"))
    inputs.dir(repoRoot.resolve("src/core"))
    inputs.dir(repoRoot.resolve("src/shared"))
    inputs.dir(repoRoot.resolve("src/renderer/src"))
    inputs.file(repoRoot.resolve("vite.mobile.config.ts"))
    outputs.dir(repoRoot.resolve("out/mobile"))
}

/** 把网页构建结果和 OCR 模型放进 APK 的 assets（web/、models/） */
abstract class LavaAssets @Inject constructor(private val fs: FileSystemOperations) : DefaultTask() {
    @get:InputDirectory
    abstract val web: DirectoryProperty

    @get:InputDirectory
    abstract val models: DirectoryProperty

    @get:OutputDirectory
    abstract val out: DirectoryProperty

    @TaskAction
    fun sync() {
        fs.sync {
            into(out)
            from(web) { into("web") }
            from(models) {
                include("det.onnx", "rec.onnx", "rec_dict.txt")
                into("models")
            }
        }
    }
}

val lavaAssets = tasks.register<LavaAssets>("lavaAssets") {
    dependsOn(buildWeb)
    web.set(repoRoot.resolve("out/mobile"))
    models.set(repoRoot.resolve("resources/models"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(lavaAssets, LavaAssets::out)
    }
}
