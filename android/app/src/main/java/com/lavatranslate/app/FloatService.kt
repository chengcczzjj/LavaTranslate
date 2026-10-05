package com.lavatranslate.app

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
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
    private val onSettings: () -> Unit = { main.post { refreshBadge() } }

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

        bubble = BubbleView(wctx, wm, onTap = { translate() }, onLongPress = { quick() }, onMoved = { side, y ->
            app.settings.update(JSONObject().put("bubbleSide", side).put("bubbleY", y))
        })
        overlay = OverlayHost(wctx, wm, ::handle)
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
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                app.settings.update(JSONObject().put("bubbleEnabled", false))
                stopSelf()
            }
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
        app.settings.offChange(onSettings)
        runCatching { if (bubble.isAttachedToWindow) wm.removeView(bubble) }
        runCatching { overlay.detach() }
        overlay.web.destroy()
        projection.stop()
        FrameStore.current = null
        if (instance === this) instance = null
        super.onDestroy()
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
        busy = true
        bubble.hideNow()
        overlay.attach()
        present(null, "quick")
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
    }

    // ------------------------------------------------------------ 网页 → 原生
    private fun handle(m: String, a: JSONObject, reply: Bridge.Reply) {
        when (m) {
            "hello" -> reply.ok(JSONObject().put("version", BuildConfig.VERSION_NAME))
            "shown" -> {
                overlay.reveal()
                busy = false
                // 输入翻译：网页里程序聚焦输入框不会弹出键盘，由原生弹
                if (mode == "quick") main.postDelayed({ overlay.showKeyboard() }, 160)
                reply.ok()
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
            .setContentText("点悬浮球翻译屏幕，长按输入文字翻译")
            .setContentIntent(open)
            .setOngoing(true)
            .setColor(0xFFE23E9A.toInt())
            .addAction(Notification.Action.Builder(null, "翻译屏幕", translate).build())
            .addAction(Notification.Action.Builder(null, "关闭悬浮球", stop).build())
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
        const val EXTRA_DELAY = "delay"
        private const val CHANNEL = "bubble"
        private const val NOTIFICATION_ID = 1

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
