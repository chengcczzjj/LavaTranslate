package com.lavatranslate.app

import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.view.Choreographer
import android.view.Display
import android.view.HapticFeedbackConstants
import android.view.WindowManager
import android.widget.Toast
import com.lavatranslate.app.capture.A11yCapturer
import com.lavatranslate.app.capture.Frame
import com.lavatranslate.app.capture.LavaAccessibilityService
import com.lavatranslate.app.capture.ProjectionCapturer
import com.lavatranslate.app.capture.ScreenCapturer
import com.lavatranslate.app.web.Bridge
import com.lavatranslate.app.web.FrameStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.Future
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * 悬浮球前台服务：管理悬浮球、全屏翻译窗口和截屏。
 * 流程：点悬浮球 → 藏起悬浮球 → 截一帧 → 同时开始 OCR、编码给模型的图片 → 网页画出截图（与屏幕一模一样）→
 * 网页取 OCR 结果、自己调模型流式翻译（core/translator.ts），译文就地浮现。
 * 长按悬浮球：同一个翻译界面以「菜单」模式打开（快捷回复 / 译成 / 设置 / 退出）。
 *
 * 省电：不用时不截屏、不联网，网页暂停；长时间不用、或系统打开省电模式时自动退出（可在设置里关掉），
 * 退出时释放截屏授权和翻译界面，并结束进程，把内存还给系统。
 */
class FloatService : Service() {
    private val app get() = LavaApp.instance
    private val main = Handler(Looper.getMainLooper())
    private lateinit var wctx: Context
    private lateinit var wm: WindowManager
    private lateinit var bubble: BubbleView
    private lateinit var overlay: OverlayHost
    lateinit var projection: ProjectionCapturer
        private set
    private val a11y by lazy { A11yCapturer(this) }

    private var busy = false
    private var mode = "translate"
    private var ocrJob: Future<JSONObject>? = null
    private var imageJob: Future<JSONObject>? = null
    private val onSettings: () -> Unit = {
        main.post {
            refreshBadge()
            scheduleIdle()
        }
    }

    /** 上次使用悬浮球的时间（elapsedRealtime，含休眠），用于「长时间不用自动退出」 */
    private var lastUse = SystemClock.elapsedRealtime()
    private val alarms by lazy { getSystemService(AlarmManager::class.java) }
    private val idleAlarm = AlarmManager.OnAlarmListener { onIdle() }

    /** 翻译界面开着时要退出：等它关掉再退 */
    private var pendingQuit: String? = null
    private val powerSave = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (getSystemService(PowerManager::class.java).isPowerSaveMode && app.settings.bool("saverExit")) quitWhenIdle(REASON_SAVER)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        startForegroundCompat(false)
        wctx = if (Build.VERSION.SDK_INT >= 30) {
            val display = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
            createDisplayContext(display).createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
        } else this
        wm = wctx.getSystemService(WindowManager::class.java)
        projection = ProjectionCapturer(this) { main.post { onProjectionStopped() } }

        bubble = BubbleView(wctx, wm, onTap = { translate() }, onLongPress = { menu() }, onMoved = { side, y ->
            touch()
            app.settings.update(JSONObject().put("bubbleSide", side).put("bubbleY", y))
        })
        overlay = OverlayHost(wctx, wm, ::handle)
        // 翻译界面的网页先加载好（加载完说 hello 后暂停，见 handle）
        app.webVisible(overlay.web, true)
        if (Settings.canDrawOverlays(this)) {
            // 先算好位置再挂窗口（刚 addView 时还没 attach，之后改位置不会生效）
            bubble.place(app.settings.str("bubbleSide"), app.settings.num("bubbleY"))
            wm.addView(bubble, bubble.params)
            bubble.show()
        }
        refreshBadge()
        app.settings.onChange(onSettings)
        // OCR 模型提前载入，第一次翻译不用等
        app.worker.execute { runCatching { app.ocr.init() } }
        // 悬浮球常驻期间每天检查一次更新
        main.postDelayed(updateTick, 60_000)
        androidx.core.content.ContextCompat.registerReceiver(this, powerSave, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED)
        getSystemService(NotificationManager::class.java).cancel(NOTICE_ID)
        touch()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> quit()
            ACTION_TRANSLATE -> main.postDelayed({ translate() }, intent.getLongExtra(EXTRA_DELAY, 0))
            ACTION_QUICK -> quick()
        }
        return START_STICKY
    }

    private val updateTick: Runnable = object : Runnable {
        override fun run() {
            com.lavatranslate.app.update.Updater.autoCheck(this@FloatService, 20 * 3600_000L)
            main.postDelayed(this, 3 * 3600_000L)
        }
    }

    override fun onDestroy() {
        main.removeCallbacks(updateTick)
        alarms.cancel(idleAlarm)
        runCatching { unregisterReceiver(powerSave) }
        app.settings.offChange(onSettings)
        runCatching { if (bubble.isAttachedToWindow) wm.removeView(bubble) }
        runCatching { overlay.detach() }
        app.webGone(overlay.web)
        overlay.web.destroy()
        projection.stop()
        FrameStore.current = null
        // OCR 模型占几十 MB 内存：悬浮球关掉就释放，下次打开再载入
        app.worker.execute { app.ocr.close() }
        if (instance === this) instance = null
        super.onDestroy()
    }

    // ------------------------------------------------------------ 退出与省电
    /**
     * 彻底退出：关掉悬浮球、常驻通知、截屏授权、翻译界面和设置页，然后结束进程释放内存。
     * 不改「悬浮球」开关：之后点 LavaTranslate 图标会重新打开。reason 不为空表示自动退出，留一条通知说明原因。
     */
    fun quit(reason: String? = null) {
        if (reason != null) notifyAutoExit(reason)
        MainActivity.instance?.finishAndRemoveTask()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        app.endProcessSoon()
    }

    private fun quitWhenIdle(reason: String) {
        if (busy || overlay.attached) pendingQuit = reason else quit(reason)
    }

    /** 用了一次悬浮球：重新计时 */
    private fun touch() {
        lastUse = SystemClock.elapsedRealtime()
        scheduleIdle()
    }

    /** 「长时间不用自动退出」的时长（毫秒），0 表示从不 */
    private fun idleLimit(): Long {
        val min = app.settings.num("idleExit")
        return if (min.isNaN() || min <= 0) 0 else (min * 60_000).toLong()
    }

    /** 到点检查一次：允许推迟 10 分钟，方便系统和别的唤醒合并（也不需要精确闹钟权限） */
    private fun scheduleIdle() {
        alarms.cancel(idleAlarm)
        val limit = idleLimit()
        if (limit > 0) alarms.setWindow(AlarmManager.ELAPSED_REALTIME_WAKEUP, lastUse + limit, 10 * 60_000L, "lava:idle", idleAlarm, main)
    }

    private fun onIdle() {
        val limit = idleLimit()
        if (limit <= 0) return
        if (busy || overlay.attached || SystemClock.elapsedRealtime() - lastUse < limit - 1000) return touch()
        quit(REASON_IDLE)
    }

    private fun notifyAutoExit(reason: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(NOTICE_CHANNEL, "自动退出提醒", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        val minutes = (idleLimit() / 60_000).toInt()
        val span = if (minutes >= 60 && minutes % 60 == 0) "${minutes / 60} 小时" else "$minutes 分钟"
        val why = if (reason == REASON_IDLE) "${span}没有使用" else "系统省电模式已打开"
        val reopen = PendingIntent.getForegroundService(
            this, 4, Intent(this, FloatService::class.java).setAction(ACTION_START), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val n = Notification.Builder(this, NOTICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle("悬浮球已自动退出")
            .setContentText("${why}，已退出以省电 · 点这里重新打开")
            .setContentIntent(reopen)
            .setAutoCancel(true)
            .setColor(LAVA)
            .setTimeoutAfter(12 * 3600_000L)
            .build()
        nm.notify(NOTICE_ID, n)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // 转屏后按保存的一侧、高度比例重新摆放
        bubble.place(app.settings.str("bubbleSide"), app.settings.num("bubbleY"))
    }

    private fun refreshBadge() {
        bubble.needsConsent = needsConsent
    }

    val needsConsent get() = app.settings.str("captureMode") != "accessibility" && !projection.active

    /** 稍后翻译（等通知栏、中转页面收起） */
    fun translateLater(delay: Long) = main.postDelayed({ translate() }, delay)

    // ------------------------------------------------------------ 截屏授权
    fun requestConsent(thenTranslate: Boolean) {
        startActivity(Intent(this, ConsentActivity::class.java).putExtra(ConsentActivity.EXTRA_TRANSLATE, thenTranslate).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** 授权结果（来自 ConsentActivity）；thenTranslate：授权后接着翻译 */
    fun onConsent(resultCode: Int, data: Intent?, thenTranslate: Boolean) {
        if (resultCode != Activity.RESULT_OK || data == null) {
            toast("没有授权截屏")
            return
        }
        try {
            // Android 14 起：拿到授权后、创建会话前，前台服务要带上 mediaProjection 类型
            startForegroundCompat(true)
            projection.start(resultCode, data)
        } catch (e: Exception) {
            startForegroundCompat(false)
            toast(e.message ?: "截屏授权失败")
            return
        }
        refreshBadge()
        // 等系统授权框完全消失再截屏
        if (thenTranslate) main.postDelayed({ translate() }, 450)
    }

    private fun onProjectionStopped() {
        startForegroundCompat(false)
        refreshBadge()
    }

    // ------------------------------------------------------------ 翻译
    fun translate() {
        if (busy || overlay.attached) return
        if (!Settings.canDrawOverlays(this)) return openMain()
        touch()
        val capturer: ScreenCapturer = if (app.settings.str("captureMode") == "accessibility") {
            if (LavaAccessibilityService.instance == null) {
                toast("免授权截屏还没开启：请在系统「无障碍」里打开 LavaTranslate")
                return openMain()
            }
            a11y
        } else {
            if (!projection.active) return requestConsent(true)
            projection
        }
        busy = true
        bubble.hideNow()
        overlay.attach()
        // 等两帧：确保藏起的悬浮球已经从屏幕上消失，不会被截进去
        val ch = Choreographer.getInstance()
        ch.postFrameCallback { ch.postFrameCallback { app.worker.execute { capture(capturer) } } }
    }

    private fun capture(c: ScreenCapturer) {
        val t0 = SystemClock.elapsedRealtime()
        val f = try {
            c.capture()
        } catch (e: Exception) {
            main.post {
                busy = false
                overlay.detach()
                bubble.show()
                toast(e.message ?: "截屏失败")
            }
            return
        }
        val captureMs = SystemClock.elapsedRealtime() - t0
        FrameStore.current = f
        if (BuildConfig.DEBUG) FrameStore.last = f
        val crop = f.crop(f.content)
        ocrJob = app.worker.submit<JSONObject> { runOcr(f, crop, captureMs) }
        imageJob = app.worker.submit<JSONObject> { encodeForModel(crop, f.content.width(), f.content.height()) }
        main.post { present(f, "translate") }
        // 网页没响应（例如 WebView 崩溃重建）时不要一直卡住
        main.postDelayed({ if (busy && overlay.attached && !overlay.visible) closeOverlay() }, 4000)
    }

    private fun quick() {
        if (busy || overlay.attached || !Settings.canDrawOverlays(this)) return
        touch()
        busy = true
        bubble.hideNow()
        overlay.attach()
        present(null, "quick")
        main.postDelayed({ if (busy && overlay.attached && !overlay.visible) closeOverlay() }, 4000)
    }

    /** 长按悬浮球：菜单（网页里画一个一模一样的球和菜单，画好后再藏起原生的球，看不出切换） */
    private fun menu() {
        if (busy || overlay.attached || !Settings.canDrawOverlays(this)) return
        touch()
        busy = true
        overlay.attach()
        present(null, "menu")
        main.postDelayed({ if (busy && overlay.attached && !overlay.visible) closeOverlay() }, 4000)
    }

    private fun present(f: Frame?, mode: String) {
        this.mode = mode
        val d = resources.displayMetrics.density
        val o = bubble.orbRect()
        val msg = JSONObject()
            .put("mode", mode)
            .put("density", d)
            .put("orb", JSONObject().put("x", o.left / d).put("y", o.top / d).put("size", o.width() / d))
            .put("side", app.settings.str("bubbleSide"))
            .put("insets", JSONObject()
                .put("top", com.lavatranslate.app.capture.Screen.content(this, 1, com.lavatranslate.app.capture.Screen.size(this).y).top / d)
                .put("bottom", com.lavatranslate.app.capture.Screen.navBottom(this) / d))
            .put("settings", app.settings.plain())
        if (f != null) msg.put("frame", JSONObject().put("id", f.id).put("w", f.width).put("h", f.height).put("content", rect(f.content)))
        overlay.bridge.emit("open", msg)
    }

    private fun runOcr(f: Frame, crop: ByteArray, captureMs: Long): JSONObject {
        val t0 = SystemClock.elapsedRealtime()
        val lines = app.ocr.recognize(crop, f.content.width(), f.content.height())
        return JSONObject()
            .put("frame", f.id)
            .put("lines", JSONArray().apply { lines.forEach { put(it.json()) } })
            .put("ms", SystemClock.elapsedRealtime() - t0)
            .put("timing", JSONObject(app.ocr.timing as Map<*, *>).put("capture", captureMs))
    }

    private fun closeOverlay() {
        overlay.detach()
        busy = false
        FrameStore.current = null
        ocrJob = null
        imageJob = null
        bubble.place(app.settings.str("bubbleSide"), app.settings.num("bubbleY"))
        bubble.show()
        touch()
        pendingQuit?.let { main.post { quit(it) } }
    }

    // ------------------------------------------------------------ 网页 → 原生
    private fun handle(m: String, a: JSONObject, reply: Bridge.Reply) {
        when (m) {
            "hello" -> {
                // 网页加载好了：不用的时候先暂停
                if (!overlay.attached) app.webVisible(overlay.web, false)
                reply.ok(JSONObject().put("version", BuildConfig.VERSION_NAME))
            }
            "shown" -> {
                overlay.reveal()
                busy = false
                if (mode == "menu") bubble.hideNow()
                // 输入翻译：网页里程序聚焦输入框不会弹出键盘，由原生弹
                if (mode == "quick") main.postDelayed({ overlay.showKeyboard() }, 160)
                reply.ok()
            }
            /** 菜单里点了「快捷回复」 */
            "keyboard" -> {
                mode = "quick"
                main.postDelayed({ overlay.showKeyboard() }, 160)
                reply.ok()
            }
            "quit" -> {
                reply.ok()
                main.post { quit() }
            }
            "close" -> {
                closeOverlay()
                reply.ok()
            }
            "ocr" -> {
                val job = ocrJob
                val img = imageJob
                if (job == null || img == null) return reply.err("截图已失效，请重新截图")
                app.worker.execute {
                    try {
                        val r = job.get()
                        if (r.optInt("frame") != a.optInt("frame")) return@execute reply.err("截图已失效，请重新截图")
                        reply.ok(r.put("image", img.get()))
                    } catch (e: Exception) {
                        reply.err("文字识别失败：${e.cause?.message ?: e.message}")
                    }
                }
            }
            "copy" -> {
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("LavaTranslate", a.optString("text")))
                reply.ok()
            }
            "settings" -> reply.ok(app.settings.update(a))
            "orb" -> {
                val y = a.optDouble("y") * resources.displayMetrics.density / com.lavatranslate.app.capture.Screen.size(this).y
                app.settings.update(JSONObject().put("bubbleSide", a.optString("side")).put("bubbleY", y))
                reply.ok()
            }
            "haptic" -> {
                overlay.root.performHapticFeedback(
                    when (a.optString("kind")) {
                        "long" -> HapticFeedbackConstants.LONG_PRESS
                        "confirm" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
                        else -> HapticFeedbackConstants.CLOCK_TICK
                    }
                )
                reply.ok()
            }
            "openSettings" -> {
                closeOverlay()
                openMain()
                reply.ok()
            }
            "net.req" -> app.net.request(overlay.bridge, a)
            "net.abort" -> app.net.abort(a.optString("rid"))
            "preconnect" -> app.net.preconnect(a.optString("url"))
            else -> reply.err("unknown method $m")
        }
    }

    // ------------------------------------------------------------ 杂项
    private fun openMain() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun toast(text: String) = main.post { Toast.makeText(this, text, Toast.LENGTH_SHORT).show() }

    private fun createChannel() {
        val ch = NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun notification(): Notification {
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), flags)
        // 从通知栏点「翻译屏幕」要先收起通知栏：经由透明页面中转，它会让通知栏收起
        val translate = PendingIntent.getActivity(this, 1, Intent(this, ConsentActivity::class.java).putExtra(ConsentActivity.EXTRA_TRANSLATE, true), flags)
        val stop = PendingIntent.getService(this, 2, Intent(this, FloatService::class.java).setAction(ACTION_STOP), flags)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle("悬浮球已开启")
            .setContentText("点悬浮球翻译屏幕，长按打开菜单")
            .setContentIntent(open)
            .setOngoing(true)
            .setColor(LAVA)
            .addAction(Notification.Action.Builder(null, "翻译屏幕", translate).build())
            .addAction(Notification.Action.Builder(null, "退出", stop).build())
            .build()
    }

    private fun startForegroundCompat(withProjection: Boolean) {
        val n = notification()
        when {
            Build.VERSION.SDK_INT >= 34 -> startForeground(
                NOTIFICATION_ID, n,
                if (withProjection) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                else ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
            else -> startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        }
    }

    companion object {
        const val ACTION_STOP = "com.lavatranslate.app.STOP"
        const val ACTION_TRANSLATE = "com.lavatranslate.app.TRANSLATE"
        const val ACTION_QUICK = "com.lavatranslate.app.QUICK"
        const val ACTION_START = "com.lavatranslate.app.START"
        const val EXTRA_DELAY = "delay"
        private const val CHANNEL = "bubble"
        private const val NOTIFICATION_ID = 1
        private const val NOTICE_CHANNEL = "notice"
        private const val NOTICE_ID = 2
        private const val REASON_IDLE = "idle"
        private const val REASON_SAVER = "saver"

        /** 熔岩色（与图标一致） */
        const val LAVA = 0xFFFF5A1F.toInt()

        @Volatile
        var instance: FloatService? = null
            private set

        fun start(ctx: Context, action: String? = null, delay: Long = 0) {
            ctx.startForegroundService(Intent(ctx, FloatService::class.java).setAction(action).putExtra(EXTRA_DELAY, delay))
        }

        private fun rect(r: Rect) = JSONObject().put("x", r.left).put("y", r.top).put("w", r.width()).put("h", r.height())

        /** 给模型的图片：太大则缩到长边 1568，太小则放大 2 倍；大图用 JPEG（与桌面版 encodeForModel 一致） */
        fun encodeForModel(rgba: ByteArray, w: Int, h: Int): JSONObject {
            val src = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            src.copyPixelsFromBuffer(ByteBuffer.wrap(rgba))
            val long = max(w, h)
            val factor = if (long > 1568) 1568f / long else if (long < 400) 2f else 1f
            val img = if (factor != 1f) Bitmap.createScaledBitmap(src, (w * factor).roundToInt(), (h * factor).roundToInt(), true) else src
            val iw = img.width
            val ih = img.height
            val big = iw * ih > 700_000
            val out = ByteArrayOutputStream()
            img.compress(if (big) Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG, 90, out)
            if (img !== src) img.recycle()
            src.recycle()
            return JSONObject()
                .put("base64", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                .put("mediaType", if (big) "image/jpeg" else "image/png")
                .put("width", iw)
                .put("height", ih)
                .put("factor", factor.toDouble())
        }
    }
}
