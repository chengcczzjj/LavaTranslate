package com.lavatranslate.app

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.Choreographer
import android.view.WindowManager
import android.widget.Toast
import androidx.core.content.ContextCompat
import com.lavatranslate.app.capture.Frame
import com.lavatranslate.app.capture.Screen
import com.lavatranslate.app.capture.ScreenCapturer
import com.lavatranslate.app.web.Bridge
import com.lavatranslate.app.web.CommonBridge
import com.lavatranslate.app.web.FrameStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.Future
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * 翻译界面的宿主：悬浮球（可选）、全屏翻译窗口、截屏 → OCR → 网页翻译。两处共用：
 * - 无障碍服务（推荐）：窗口是无障碍图层，不需要悬浮窗权限、前台服务和常驻通知，开机后系统自动拉起；
 * - 悬浮球前台服务（截屏授权模式）。
 *
 * 流程：点悬浮球 → 藏起悬浮球 → 截一帧 → 同时开始 OCR、编码给模型的图片 → 网页画出截图（与屏幕一模一样）→
 * 网页取 OCR 结果、自己调模型流式翻译（core/translator.ts），译文就地浮现。
 * 长按悬浮球：同一个翻译界面以「菜单」模式打开（快捷回复 / 译成 / 设置 / 退出）。
 *
 * 省电：翻译界面和 OCR 模型都是用时才载入；关掉 [WARM_MS] 后释放（网页引擎、模型加起来几百 MB），
 * 不让它们常驻内存、把别的应用挤出去。
 */
class ScreenHost(
    private val ctx: Context,
    private val wm: WindowManager,
    private val windowType: Int,
    private val owner: Owner
) {
    interface Owner {
        /** 给网页区分宿主："a11y" 或 "float" */
        val kind: String

        /** 能不能显示窗口（悬浮窗权限等）；不能时自己去处理（打开设置页） */
        fun ready(): Boolean = true

        /** 这次截屏用哪个；返回 null 表示这次不翻译（已去请求授权、已提示等） */
        fun capturer(): ScreenCapturer?

        /** 菜单里的「退出」 */
        fun quit()

        /** 用了一次（重新计时） */
        fun used() {}

        /** 翻译界面关掉了 */
        fun closed() {}

        /** 空闲释放完了 */
        fun released() {}

        /** 屏幕关了（翻译界面没开着，资源已释放） */
        fun screenOff() {}
    }

    private val app get() = LavaApp.instance
    private val main = Handler(Looper.getMainLooper())

    private var bubble: BubbleView? = null
    private var bubbleOn = false
    private var overlay: OverlayHost? = null

    /** 网页加载好了（说过 hello）：冷启动时等它要久一些 */
    private var webReady = false

    private var busy = false
    private var mode = "translate"
    private var ocrJob: Future<JSONObject>? = null
    private var imageJob: Future<JSONObject>? = null

    /** 翻译界面开着（或正在打开） */
    val active get() = busy || overlay?.attached == true

    /**
     * 锁屏界面在显示：无障碍图层会盖在锁屏上面，这时什么都不显示、不响应。
     * 自己记状态：解锁广播到达时 isKeyguardLocked 有时还是 true（锁屏正在退场）
     */
    private var locked = ctx.getSystemService(KeyguardManager::class.java).isKeyguardLocked

    /**
     * 关屏：收起翻译界面和悬浮球（不然亮屏后会盖在锁屏上），并立即释放网页和模型，不必再等 [WARM_MS]；
     * 解锁后悬浮球再出来。
     */
    private val screen = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    locked = true
                    if (overlay?.attached == true) closeOverlay()
                    // 撤掉窗口而不只是藏起来：透明的窗口在锁屏上照样会挡住触摸
                    bubble?.let { if (it.isAttachedToWindow) wm.removeView(it) }
                    if (active) return
                    release()
                    owner.screenOff()
                }
                // 没有设锁屏（或刚关屏马上亮屏，还没锁上）时亮屏就算解锁
                Intent.ACTION_SCREEN_ON -> if (!context.getSystemService(KeyguardManager::class.java).isKeyguardLocked) unlocked()
                Intent.ACTION_USER_PRESENT -> unlocked()
            }
        }
    }

    init {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        // 要 EXPORTED：解锁广播由系统界面（另一个应用）发出，NOT_EXPORTED 收不到；三个都是受保护的系统广播，别的应用发不了
        ContextCompat.registerReceiver(app, screen, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    private fun unlocked() {
        locked = false
        if (bubbleOn) bubbleVisible(true)
    }

    // ------------------------------------------------------------ 悬浮球
    fun bubbleVisible(on: Boolean) {
        bubbleOn = on
        if (!on) {
            bubble?.let { b ->
                if (b.isAttachedToWindow) wm.removeView(b)
            }
            bubble = null
            return
        }
        val b = bubble ?: BubbleView(ctx, wm, windowType, onTap = { translate() }, onLongPress = { menu() }, onMoved = { side, y ->
            used()
            app.settings.update(JSONObject().put("bubbleSide", side).put("bubbleY", y))
        }).also { bubble = it }
        if (locked) return
        if (!b.isAttachedToWindow) {
            // 先算好位置再挂窗口（刚 addView 时还没 attach，之后改位置不会生效）
            b.place(app.settings.str("bubbleSide"), app.settings.num("bubbleY"))
            wm.addView(b, b.params)
        }
        if (!active) b.show()
    }

    /** 截屏授权已失效：球上显示小黄点 */
    fun badge(on: Boolean) {
        bubble?.needsConsent = on
    }

    /** 转屏后按保存的一侧、高度比例重新摆放 */
    fun placeBubble() {
        bubble?.place(app.settings.str("bubbleSide"), app.settings.num("bubbleY"))
    }

    // ------------------------------------------------------------ 打开
    /** 无障碍按钮、快捷开关：开着就关，没开就翻译 */
    fun toggle() {
        if (overlay?.attached == true) {
            if (!busy) overlay?.bridge?.emit("dismiss")
            return
        }
        translate()
    }

    fun translate() {
        if (active || locked || !owner.ready()) return
        val capturer = owner.capturer() ?: return
        start()
        // 模型和截屏一起准备：冷启动时省下载入模型的时间
        app.worker.execute { runCatching { app.ocr.init() } }
        bubble?.hideNow()
        overlay().attach()
        // 等两帧：确保藏起的悬浮球已经从屏幕上消失，不会被截进去
        val ch = Choreographer.getInstance()
        ch.postFrameCallback { ch.postFrameCallback { app.worker.execute { capture(capturer) } } }
    }

    /** 输入翻译（快捷回复）：不截屏 */
    fun quick() {
        if (active || locked || !owner.ready()) return
        start()
        bubble?.hideNow()
        overlay().attach()
        present(null, "quick")
    }

    /** 长按悬浮球：菜单（网页里画一个一模一样的球和菜单，画好后再藏起原生的球，看不出切换） */
    fun menu() {
        if (active || locked || !owner.ready()) return
        start()
        overlay().attach()
        present(null, "menu")
    }

    /** 调试：从点击到翻译界面出现的耗时 */
    private var startedAt = 0L
    private var coldStart = false

    private fun start() {
        startedAt = SystemClock.elapsedRealtime()
        coldStart = overlay == null
        busy = true
        used()
        main.removeCallbacks(releaseTask)
        // 网页没响应（例如 WebView 崩溃重建）时不要一直卡住；冷启动要载入网页引擎，多等一会
        val wait = if (webReady) 4000L else 12000L
        main.postDelayed({ if (busy && overlay?.attached == true && overlay?.visible == false) closeOverlay() }, wait)
    }

    private fun overlay(): OverlayHost = overlay ?: OverlayHost(ctx, wm, windowType, ::handle).also {
        overlay = it
        webReady = false
    }

    private fun capture(c: ScreenCapturer) {
        val t0 = SystemClock.elapsedRealtime()
        val f = try {
            c.capture()
        } catch (e: Exception) {
            main.post {
                closeOverlay()
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
    }

    private fun present(f: Frame?, mode: String) {
        this.mode = mode
        val d = ctx.resources.displayMetrics.density
        val o = bubble?.orbRect() ?: BubbleView.restingRect(ctx, app.settings.str("bubbleSide"), app.settings.num("bubbleY"))
        val msg = JSONObject()
            .put("mode", mode)
            .put("host", owner.kind)
            .put("bubble", bubbleOn)
            .put("density", d)
            .put("orb", JSONObject().put("x", o.left / d).put("y", o.top / d).put("size", o.width() / d))
            .put("side", app.settings.str("bubbleSide"))
            .put("insets", JSONObject()
                .put("top", Screen.content(ctx, 1, Screen.size(ctx).y).top / d)
                .put("bottom", Screen.navBottom(ctx) / d))
            .put("settings", app.settings.plain())
        if (f != null) msg.put("frame", JSONObject().put("id", f.id).put("w", f.width).put("h", f.height).put("content", rect(f.content)))
        overlay?.bridge?.emit("open", msg)
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

    // ------------------------------------------------------------ 关闭与释放
    fun closeOverlay() {
        overlay?.detach()
        busy = false
        FrameStore.current = null
        ocrJob = null
        imageJob = null
        if (bubbleOn && !locked) {
            placeBubble()
            bubble?.show()
        }
        used()
        scheduleRelease()
        owner.closed()
    }

    private val releaseTask = Runnable { release() }

    private fun scheduleRelease() {
        main.removeCallbacks(releaseTask)
        main.postDelayed(releaseTask, WARM_MS)
    }

    /** 释放翻译界面的网页和 OCR 模型（下次用时重新载入） */
    fun release() {
        main.removeCallbacks(releaseTask)
        if (active) return
        overlay?.destroy()
        overlay = null
        webReady = false
        app.worker.execute { app.ocr.close() }
        owner.released()
    }

    /** 宿主销毁：撤掉所有窗口 */
    fun destroy() {
        runCatching { app.unregisterReceiver(screen) }
        main.removeCallbacksAndMessages(null)
        bubbleVisible(false)
        overlay?.destroy()
        overlay = null
        busy = false
        FrameStore.current = null
        app.worker.execute { app.ocr.close() }
    }

    private fun used() = owner.used()

    // ------------------------------------------------------------ 网页 → 原生
    private fun handle(m: String, a: JSONObject, reply: Bridge.Reply) {
        val overlay = overlay ?: return reply.err("翻译界面已关闭")
        when (m) {
            "hello" -> {
                webReady = true
                // 网页加载好了：不用的时候先暂停
                if (!overlay.attached) app.webVisible(overlay.web, false)
                reply.ok(JSONObject().put("version", BuildConfig.VERSION_NAME))
            }
            "shown" -> {
                if (BuildConfig.DEBUG) android.util.Log.i("LavaTranslate", "shown $mode +${SystemClock.elapsedRealtime() - startedAt}ms ${if (coldStart) "cold" else "warm"}")
                overlay.reveal()
                busy = false
                if (mode == "menu") bubble?.hideNow()
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
                main.post {
                    closeOverlay()
                    owner.quit()
                }
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
            "orb" -> {
                val y = a.optDouble("y") * ctx.resources.displayMetrics.density / Screen.size(ctx).y
                app.settings.update(JSONObject().put("bubbleSide", a.optString("side")).put("bubbleY", y))
                reply.ok()
            }
            "openSettings" -> {
                closeOverlay()
                ctx.startActivity(Intent(ctx, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                reply.ok()
            }
            else -> if (!CommonBridge.handle(ctx, overlay.root, overlay.bridge, m, a, reply)) reply.err("unknown method $m")
        }
    }

    private fun toast(text: String) = main.post { Toast.makeText(ctx, text, Toast.LENGTH_SHORT).show() }

    companion object {
        /** 翻译界面关掉后，网页和 OCR 模型再留这么久（接着翻译不用重新载入），然后释放 */
        const val WARM_MS = 3 * 60_000L

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
