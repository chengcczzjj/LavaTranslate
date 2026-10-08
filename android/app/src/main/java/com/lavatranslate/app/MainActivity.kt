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
        instance = this
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
        // 进程被杀后重新打开：截屏授权模式之前开着悬浮球就恢复（无障碍模式的悬浮球由系统拉起的无障碍服务负责）
        if (FloatService.wanted(this) && FloatService.instance == null) FloatService.start(this)
    }

    override fun onResume() {
        super.onResume()
        app.webVisible(web, true)
        bridge.emit("status", status())
        // 在翻译界面里改过的设置（隐藏悬浮球、译成…）
        bridge.emit("settings", app.settings.public())
        // 刚从「安装未知应用」页面回来并且允许了：直接继续安装
        if (Updater.awaitingPermission && packageManager.canRequestPackageInstalls()) Updater.install(this)
    }

    override fun onPause() {
        super.onPause()
        // 设置页退到后台：网页暂停，不占 CPU
        app.webVisible(web, false)
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
        if (instance === this) instance = null
        app.webGone(web)
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
        .put("a11yButton", LavaAccessibilityService.buttonAssigned(this))
        .put("a11yVolume", LavaAccessibilityService.volumeAssigned(this))
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
            "setSettings" -> {
                val r = app.settings.update(a)
                if (a.has("captureMode")) applyMode()
                reply.ok(r)
            }
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
                openAccessibility()
                reply.ok()
            }
            "addTile" -> addTile(a.optBoolean("quick"), reply)
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
                // 无障碍模式：悬浮球由无障碍服务显示，只要它开着
                if (LavaAccessibilityService.mode) {
                    app.settings.update(JSONObject().put("bubbleEnabled", true))
                    return if (LavaAccessibilityService.instance == null) reply.err("a11y") else reply.ok()
                }
                if (!Settings.canDrawOverlays(this)) return reply.err("overlay")
                app.settings.update(JSONObject().put("bubbleEnabled", true))
                FloatService.start(this)
                // 截屏授权模式：开启时顺便授权一次，之后点悬浮球直接翻译
                startActivity(Intent(this, ConsentActivity::class.java))
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
            /** 彻底退出：关掉悬浮球（释放截屏授权、OCR 模型、翻译界面）和设置页 */
            "quitApp" -> {
                reply.ok()
                FloatService.instance?.quit() ?: run {
                    finishAndRemoveTask()
                    app.endProcessSoon()
                }
            }
            // 调试：用最近一帧对比不同 OCR 配置的耗时
            "ocrBench" -> {
                if (!BuildConfig.DEBUG) return reply.err("debug only")
                val f = com.lavatranslate.app.web.FrameStore.last ?: return reply.err("no frame")
                app.worker.execute {
                    try {
                        val ocr = com.lavatranslate.app.ocr.PaddleOcr(this, a.optInt("threads", 4))
                        ocr.detLimit = a.optInt("detLimit", 1600)
                        ocr.spinning = a.optBoolean("spin", false)
                        ocr.arena = a.optBoolean("arena", true)
                        val crop = f.crop(f.content)
                        val t0 = android.os.SystemClock.elapsedRealtime()
                        ocr.init()
                        val init = android.os.SystemClock.elapsedRealtime() - t0
                        val runs = org.json.JSONArray()
                        var n = 0
                        repeat(3) {
                            // cpu：这一次识别整个进程用掉的 CPU 时间（各线程相加），看耗电
                            val c0 = android.os.Process.getElapsedCpuTime()
                            n = ocr.recognize(crop, f.content.width(), f.content.height()).size
                            runs.put(JSONObject(ocr.timing as Map<*, *>).put("cpu", android.os.Process.getElapsedCpuTime() - c0))
                        }
                        // heap：识别完、还没释放时原生堆占用（MB），看内存池留了多少
                        val heap = android.os.Debug.getNativeHeapAllocatedSize() / 1048576
                        ocr.close()
                        reply.ok(JSONObject().put("init", init).put("lines", n).put("runs", runs).put("heap", heap).put("cores", Runtime.getRuntime().availableProcessors()))
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

    /** 切换了启动方式：截屏授权模式的悬浮球服务按需开关（无障碍服务自己根据设置显示或藏起悬浮球） */
    private fun applyMode() {
        if (LavaAccessibilityService.mode) stopService(Intent(this, FloatService::class.java))
        else if (FloatService.wanted(this) && FloatService.instance == null) FloatService.start(this)
    }

    /** 直接打开本应用的无障碍设置页（不支持时退回无障碍列表） */
    private fun openAccessibility() {
        if (Build.VERSION.SDK_INT >= 31) try {
            val me = android.content.ComponentName(this, LavaAccessibilityService::class.java).flattenToString()
            return startActivity(Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS").putExtra(Intent.EXTRA_COMPONENT_NAME, me))
        } catch (_: Exception) {
        }
        open(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    /** 请系统把快捷开关加到下拉菜单（Android 13 起）；更早的系统要用户自己在编辑快捷开关里拖进去 */
    private fun addTile(quick: Boolean, reply: Bridge.Reply) {
        if (Build.VERSION.SDK_INT < 33) return reply.err("manual")
        val cls = if (quick) QuickReplyTileService::class.java else TranslateTileService::class.java
        val sbm = getSystemService(android.app.StatusBarManager::class.java)
        try {
            sbm.requestAddTileService(
                android.content.ComponentName(this, cls),
                getString(if (quick) R.string.tile_quick_label else R.string.tile_label),
                android.graphics.drawable.Icon.createWithResource(this, if (quick) R.drawable.ic_tile_reply else R.drawable.ic_tile),
                mainExecutor
            ) { result ->
                when (result) {
                    android.app.StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED,
                    android.app.StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED -> reply.ok("added")
                    android.app.StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_NOT_ADDED -> reply.ok("declined")
                    else -> reply.err("manual")
                }
            }
        } catch (_: Exception) {
            // 部分系统（定制 ROM）不支持：让用户手动添加
            reply.err("manual")
        }
    }

    companion object {
        /** 退出时一起关掉 */
        @Volatile
        var instance: MainActivity? = null
            private set
    }

    @Deprecated("onRequestPermissionsResult")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        bridge.emit("status", status())
    }
}
