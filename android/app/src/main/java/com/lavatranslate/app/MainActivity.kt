package com.lavatranslate.app

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowInsets
import android.webkit.WebView
import android.window.OnBackInvokedDispatcher
import androidx.core.view.WindowCompat
import com.lavatranslate.app.capture.LavaAccessibilityService
import com.lavatranslate.app.update.Updater
import com.lavatranslate.app.web.Bridge
import com.lavatranslate.app.web.createWebView
import org.json.JSONObject

/** 设置页：网页（settings.html）+ 各种系统权限的跳转 */
class MainActivity : Activity() {
    private val app get() = LavaApp.instance
    private lateinit var web: WebView
    private lateinit var bridge: Bridge
    private val onUpdate: (JSONObject) -> Unit = { bridge.emit("update", it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        web = createWebView(this, "settings.html", transparent = false)
        web.setBackgroundColor(0xFF0E0E14.toInt())
        bridge = Bridge(web, ::handle)
        setContentView(web)
        web.setOnApplyWindowInsetsListener { _, insets ->
            val d = resources.displayMetrics.density
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val ime = insets.getInsets(WindowInsets.Type.ime()).bottom
                bridge.emit("insets", JSONObject().put("top", bars.top / d).put("bottom", bars.bottom / d).put("ime", ime / d))
            }
            insets
        }
        // 返回手势交给网页：先收起面板，没有面板再退出
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { bridge.emit("back") }
        Updater.onChange(onUpdate)
        Updater.autoCheck(this, 6 * 3600_000L)
        handleIntent(intent)
        // 进程被杀后重新打开：之前开着悬浮球就恢复
        if (app.settings.bool("bubbleEnabled") && Settings.canDrawOverlays(this) && FloatService.instance == null) FloatService.start(this)
    }

    override fun onResume() {
        super.onResume()
        bridge.emit("status", status())
        // 刚从「安装未知应用」页面回来并且允许了：直接继续安装
        if (Updater.awaitingPermission && packageManager.canRequestPackageInstalls()) Updater.install(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** 从「新版本已下载」通知点进来：直接安装 */
    private fun handleIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(Updater.EXTRA_UPDATE, false) != true) return
        val s = Updater.state().optString("state")
        if (s == "ready") Updater.install(this) else if (s == "available") Updater.download(this) else Updater.check(this, auto = false)
    }

    override fun onDestroy() {
        Updater.offChange(onUpdate)
        web.destroy()
        super.onDestroy()
    }

    @Deprecated("onBackPressed")
    override fun onBackPressed() {
        bridge.emit("back")
    }

    private fun status(): JSONObject = JSONObject()
        .put("overlay", Settings.canDrawOverlays(this))
        .put("notifications", Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
        .put("a11ySupported", LavaAccessibilityService.supported)
        .put("a11yEnabled", LavaAccessibilityService.enabled(this))
        .put("a11yConnected", LavaAccessibilityService.instance != null)
        .put("running", FloatService.instance != null)
        .put("projection", FloatService.instance?.projection?.active == true)
        .put("battery", getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName))
        .put("brand", Build.MANUFACTURER)
        .put("sdk", Build.VERSION.SDK_INT)
        .put("version", BuildConfig.VERSION_NAME)

    private fun open(intent: Intent) {
        try {
            startActivity(intent)
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
    }

    private fun handle(m: String, a: JSONObject, reply: Bridge.Reply) {
        when (m) {
            "hello" -> reply.ok(status())
            "status" -> reply.ok(status())
            "getSettings" -> reply.ok(app.settings.public())
            "setSettings" -> reply.ok(app.settings.update(a))
            /** 某个服务的明文配置：设置页要用它拉模型列表、测试连接 */
            "provider" -> reply.ok(app.settings.plain().optJSONObject("providers")?.optJSONObject(a.optString("id")) ?: JSONObject())
            "requestOverlay" -> {
                open(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
                reply.ok()
            }
            "requestNotifications" -> {
                if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 3)
                reply.ok()
            }
            "openAccessibility" -> {
                open(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                reply.ok()
            }
            "requestBattery" -> {
                @Suppress("BatteryLife")
                open(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                reply.ok()
            }
            "openAppDetails" -> {
                open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                reply.ok()
            }
            "openUrl" -> {
                val url = a.optString("url")
                if (url.startsWith("https://")) open(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                reply.ok()
            }
            "startBubble" -> {
                if (!Settings.canDrawOverlays(this)) return reply.err("overlay")
                app.settings.update(JSONObject().put("bubbleEnabled", true))
                FloatService.start(this)
                // 截屏授权模式：开启时顺便授权一次，之后点悬浮球直接翻译
                if (app.settings.str("captureMode") != "accessibility") startActivity(Intent(this, ConsentActivity::class.java))
                reply.ok()
            }
            "stopBubble" -> {
                app.settings.update(JSONObject().put("bubbleEnabled", false))
                stopService(Intent(this, FloatService::class.java))
                reply.ok()
            }
            "authorize" -> {
                if (FloatService.instance == null) FloatService.start(this)
                startActivity(Intent(this, ConsentActivity::class.java))
                reply.ok()
            }
            "copy" -> {
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("LavaTranslate", a.optString("text")))
                reply.ok()
            }
            "exit" -> {
                finish()
                reply.ok()
            }
            // 调试：用最近一帧对比不同 OCR 配置的耗时
            "ocrBench" -> {
                if (!BuildConfig.DEBUG) return reply.err("debug only")
                val f = com.lavatranslate.app.web.FrameStore.last ?: return reply.err("no frame")
                app.worker.execute {
                    try {
                        val ocr = com.lavatranslate.app.ocr.PaddleOcr(this, a.optInt("threads", 4))
                        ocr.detLimit = a.optInt("detLimit", 1600)
                        val crop = f.crop(f.content)
                        val t0 = android.os.SystemClock.elapsedRealtime()
                        ocr.init()
                        val init = android.os.SystemClock.elapsedRealtime() - t0
                        val runs = org.json.JSONArray()
                        var n = 0
                        repeat(3) {
                            n = ocr.recognize(crop, f.content.width(), f.content.height()).size
                            runs.put(JSONObject(ocr.timing as Map<*, *>))
                        }
                        ocr.close()
                        reply.ok(JSONObject().put("init", init).put("lines", n).put("runs", runs).put("cores", Runtime.getRuntime().availableProcessors()))
                    } catch (e: Throwable) {
                        reply.err(e.toString())
                    }
                }
            }
            "update.state" -> reply.ok(Updater.state())
            "update.check" -> {
                Updater.check(this, auto = false)
                reply.ok()
            }
            "update.download" -> {
                Updater.download(this)
                reply.ok()
            }
            "update.cancel" -> {
                Updater.cancel()
                reply.ok()
            }
            "update.install" -> reply.ok(Updater.install(this))
            "net.req" -> app.net.request(bridge, a)
            "net.abort" -> app.net.abort(a.optString("rid"))
            "preconnect" -> app.net.preconnect(a.optString("url"))
            else -> reply.err("unknown method $m")
        }
    }

    @Deprecated("onRequestPermissionsResult")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        bridge.emit("status", status())
    }
}
