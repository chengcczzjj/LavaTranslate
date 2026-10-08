package com.lavatranslate.app

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Choreographer
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.widget.Toast
import androidx.core.content.ContextCompat
import com.lavatranslate.app.capture.A11yCapturer
import com.lavatranslate.app.capture.CaptureException
import com.lavatranslate.app.capture.Frame
import com.lavatranslate.app.capture.LavaAccessibilityService
import com.lavatranslate.app.capture.NodeText
import com.lavatranslate.app.capture.Screen
import com.lavatranslate.app.ui.CapsuleView
import com.lavatranslate.app.ui.GlassWindow
import com.lavatranslate.app.ui.PanelView
import com.lavatranslate.app.update.Updater
import com.lavatranslate.app.web.Bridge
import com.lavatranslate.app.web.CommonBridge
import com.lavatranslate.app.web.FrameStore
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * 无障碍模式的界面（整个都在无障碍服务里，见 LavaAccessibilityService）：
 *
 * - **面板**：点 LavaTranslate 图标（或系统无障碍按钮）出现的毛玻璃小窗，翻译 / 回复 / 设置，右上角关闭；
 * - **实时翻译**：点「翻译」面板缩成贴边的小胶囊，译文盖在原文位置上，但触摸都穿过去交给下面的应用。
 *   一滑动（应用发出滚动、换页事件）译文立刻藏起；停下 [SETTLE_MS] 后重新读屏、翻译。
 *   文字优先直接从无障碍节点读（逐行精确位置，不用 OCR），读不到（游戏、图片）才截图做 OCR；
 *   网页那边有译文缓存，滑回看过的内容立刻显示，只把新出现的文字发给模型。
 *   小胶囊：按住「对比」看原文、「回复」写回复、「退出」回到面板；
 * - **回复**：面板上的「回复」或胶囊上的「回复」，打开回复框（输入翻译）。
 *
 * 只在实时翻译时订阅界面事件；不翻译时没有任何事件、动画和后台工作。翻译界面的网页在面板出现时预先载入，
 * 用完（或面板空闲）[WARM_MS] 后释放；锁屏时什么都不显示。
 */
class LiveHost(private val svc: LavaAccessibilityService) {
    private enum class State { HIDDEN, PANEL, LIVE, QUICK }

    private val app get() = LavaApp.instance
    private val main = Handler(Looper.getMainLooper())
    private val wm = svc.getSystemService(WindowManager::class.java)
    private val density = svc.resources.displayMetrics.density
    private val capturer = A11yCapturer(svc)

    private var state = State.HIDDEN
    /** 回复框关掉后回到哪个状态 */
    private var afterQuick = State.HIDDEN

    private var panel: GlassWindow? = null
    private var panelView: PanelView? = null
    private var capsule: GlassWindow? = null
    private var capsuleView: CapsuleView? = null
    private var overlay: OverlayHost? = null
    private var webReady = false

    /** 设置页开着：面板先藏起来 */
    private var settingsShown = false
    private var locked = svc.getSystemService(KeyguardManager::class.java).isKeyguardLocked

    // ------------------------------------------------------------ 实时翻译的状态
    /** 每次读屏的编号：旧的读屏结果、旧的网页回复都丢掉 */
    private var scanGen = 0
    private var frameId = 0
    /** 当前译文层在屏幕上（不是被滑动藏起、也不是正在读屏） */
    private var layerOn = false
    private var peeking = false
    private var replying = false
    private var source = Source.NONE
    private var signature = 0

    private enum class Source { NONE, NODES, OCR }

    val active get() = state == State.LIVE || state == State.QUICK

    // ------------------------------------------------------------ 面板
    fun showPanel() {
        when (state) {
            State.PANEL -> return showPanelWindow()
            State.LIVE, State.QUICK -> return
            State.HIDDEN -> {}
        }
        state = State.PANEL
        app.settings.update(JSONObject().put("panelOpen", true))
        showPanelWindow()
        prewarm()
    }

    /** 系统无障碍按钮：面板开着就收起；翻译中就退出翻译 */
    fun togglePanel() {
        when (state) {
            State.HIDDEN -> showPanel()
            State.PANEL -> closePanel()
            State.LIVE -> stopLive()
            State.QUICK -> {}
        }
    }

    /** 换成了截屏授权模式：无障碍这边的界面都收起 */
    fun hideAll() {
        if (state == State.LIVE) stopLive(toPanel = false)
        if (state == State.QUICK) endQuick()
        closePanel()
    }

    fun closePanel() {
        if (state != State.PANEL) return
        state = State.HIDDEN
        app.settings.update(JSONObject().put("panelOpen", false))
        panelView?.animate()?.alpha(0f)?.scaleX(0.9f)?.scaleY(0.9f)?.setDuration(150)?.withEndAction { panel?.dismiss() }?.start()
        scheduleRelease()
    }

    private fun showPanelWindow() {
        if (locked || settingsShown || state != State.PANEL) return
        val v = panelView ?: PanelView(svc, onTranslate = { startLive() }, onReply = { quick() }, onSettings = { openSettings() }, onClose = { closePanel() }).also { panelView = it }
        val g = panel ?: GlassWindow(svc, v, 26f, onMoved = { x, y -> savePanel(x, y) }).also { panel = it }
        if (g.showing) return
        val (w, h) = g.measure()
        val size = Screen.size(svc)
        val fx = app.settings.num("panelX").takeIf { !it.isNaN() } ?: ((size.x - w) / 2.0 / size.x)
        val fy = app.settings.num("panelY").takeIf { !it.isNaN() } ?: 0.6
        g.show(clampX((fx * size.x).roundToInt(), w), clampY((fy * size.y).roundToInt(), h))
        v.alpha = 0f
        v.scaleX = 0.92f
        v.scaleY = 0.92f
        v.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(200).start()
    }

    private fun savePanel(x: Int, y: Int) {
        val size = Screen.size(svc)
        val (w, h) = panel?.measure() ?: return
        val cx = clampX(x, w)
        val cy = clampY(y, h)
        panel?.move(cx, cy)
        app.settings.update(JSONObject().put("panelX", cx.toDouble() / size.x).put("panelY", cy.toDouble() / size.y))
    }

    private fun clampX(x: Int, w: Int): Int = x.coerceIn((4 * density).toInt(), Screen.size(svc).x - w - (4 * density).toInt())

    private fun clampY(y: Int, h: Int): Int {
        val size = Screen.size(svc)
        val top = Screen.content(svc, size.x, size.y).top
        return y.coerceIn(top + (4 * density).toInt(), size.y - Screen.navBottom(svc) - h - (4 * density).toInt())
    }

    private fun openSettings() {
        settingsShown = true
        panel?.dismiss()
        svc.startActivity(Intent(svc, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** 设置页可见时面板先藏起来，离开设置页再出来 */
    fun settingsVisible(on: Boolean) {
        settingsShown = on
        if (on) panel?.dismiss() else showPanelWindow()
    }

    // ------------------------------------------------------------ 小胶囊
    private fun showCapsule() {
        val v = capsuleView ?: CapsuleView(svc, onPeek = { peek(it) }, onReply = { reply() }, onExit = { stopLive() }).also { capsuleView = it }
        val g = capsule ?: GlassWindow(svc, v, 24f, onMoved = { x, y -> snapCapsule(x, y) }, onOutside = { touchedOutside() }).also { capsule = it }
        if (locked) return
        val (w, h) = g.measure()
        val size = Screen.size(svc)
        val side = app.settings.str("capsuleSide").ifEmpty { "right" }
        val fy = app.settings.num("capsuleY").takeIf { !it.isNaN() } ?: 0.42
        g.show(edgeX(side, w), clampY((fy * size.y).roundToInt(), h))
        v.alpha = 0f
        v.scaleX = 0.7f
        v.scaleY = 0.7f
        v.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(200).start()
    }

    private fun edgeX(side: String, w: Int) = if (side == "left") (6 * density).toInt() else Screen.size(svc).x - w - (6 * density).toInt()

    /** 松手贴到最近的一边 */
    private fun snapCapsule(x: Int, y: Int) {
        val g = capsule ?: return
        val (w, h) = g.measure()
        val size = Screen.size(svc)
        val side = if (x + w / 2 < size.x / 2) "left" else "right"
        val cy = clampY(y, h)
        g.move(edgeX(side, w), cy)
        app.settings.update(JSONObject().put("capsuleSide", side).put("capsuleY", cy.toDouble() / size.y))
    }

    private fun capsuleRect(): Rect? {
        val g = capsule ?: return null
        if (!g.showing) return null
        val (w, h) = g.measure()
        return Rect(g.winX, g.winY, g.winX + w, g.winY + h)
    }

    // ------------------------------------------------------------ 实时翻译
    /** 面板上的「翻译」，或下拉快捷开关「翻译屏幕」 */
    fun startLive() {
        if (locked || state == State.LIVE || state == State.QUICK) return
        val fromPanel = state == State.PANEL && panel?.showing == true
        state = State.LIVE
        app.settings.update(JSONObject().put("panelOpen", true))
        main.removeCallbacks(releaseTask)
        val begin = {
            panel?.dismiss()
            showCapsule()
            beginLive()
        }
        // 面板缩向胶囊所在的一边，消失后再截屏（不能把面板截进去）
        if (fromPanel) {
            val pv = panelView!!
            val right = app.settings.str("capsuleSide") != "left"
            pv.pivotX = if (right) pv.width.toFloat() else 0f
            pv.pivotY = pv.height / 2f
            pv.animate().alpha(0f).scaleX(0.4f).scaleY(0.4f).setDuration(170).withEndAction(begin).start()
        } else begin()
        tips()
    }

    private fun beginLive() {
        val o = overlay()
        o.passthrough(false)
        layerOn = false
        peeking = false
        replying = false
        lastError = ""
        source = Source.NONE
        o.bridge.emit("open", openMsg("live"))
        subscribe(true)
        scan()
    }

    /** 小胶囊上的「退出」：回到面板 */
    fun stopLive(toPanel: Boolean = true) {
        if (state != State.LIVE) return
        subscribe(false)
        main.removeCallbacks(settle)
        main.removeCallbacks(contentCheck)
        scanGen++
        overlay?.bridge?.emit("live.stop")
        overlay?.detach()
        FrameStore.current = null
        capsuleView?.busy(false)
        capsule?.dismiss()
        state = if (toPanel) State.PANEL else State.HIDDEN
        if (toPanel) showPanelWindow()
        scheduleRelease()
        Updater.autoCheck(svc, 20 * 3600_000L)
    }

    /** 读屏：藏起译文层 → 等它从屏幕上消失 → 截屏、读文字 → 交给网页翻译 */
    private fun scan() {
        if (state != State.LIVE || replying) return
        main.removeCallbacks(settle)
        main.removeCallbacks(contentCheck)
        val gen = ++scanGen
        layer(false)
        capsuleView?.busy(true)
        val mask = capsuleRect()
        val ch = Choreographer.getInstance()
        ch.postFrameCallback { ch.postFrameCallback { app.worker.execute { readScreen(gen, mask) } } }
    }

    private fun readScreen(gen: Int, mask: Rect?) {
        val t0 = SystemClock.elapsedRealtime()
        val f = try {
            capturer.capture()
        } catch (e: CaptureException) {
            // 截屏太频繁（系统限制每秒约 3 次）：稍等再来
            if (e.message?.contains("频繁") == true) main.postDelayed({ if (gen == scanGen) scan() }, 400)
            else main.post { if (gen == scanGen) liveError(e.message ?: "截屏失败") }
            return
        }
        if (gen != scanGen) return
        val captureMs = SystemClock.elapsedRealtime() - t0
        val c = f.content
        val nodes = runCatching { NodeText.read(svc, c, density) }.getOrNull()
        val useNodes = nodes != null && nodes.lines.isNotEmpty() && nodes.unknown <= nodes.lines.size / 4 + 1
        if (mask != null) f.fill(mask)
        val crop = f.crop(c)
        val t1 = SystemClock.elapsedRealtime()
        val lines = JSONArray()
        if (useNodes) {
            nodes!!.lines.forEachIndexed { i, l ->
                lines.put(JSONObject().put("id", i + 1).put("text", l.text).put("score", 1)
                    .put("box", JSONObject().put("x", l.box.left - c.left).put("y", l.box.top - c.top).put("w", l.box.width()).put("h", l.box.height())))
            }
        } else {
            val ocr = try {
                app.ocr.recognize(crop, c.width(), c.height())
            } catch (e: Exception) {
                main.post { if (gen == scanGen) liveError("文字识别失败：${e.message}") }
                return
            }
            ocr.forEach { lines.put(it.json()) }
        }
        val readMs = SystemClock.elapsedRealtime() - t1
        val image = ScreenHost.encodeForModel(crop, c.width(), c.height())
        if (gen != scanGen) return
        FrameStore.current = f
        if (BuildConfig.DEBUG) FrameStore.last = f
        main.post {
            if (gen != scanGen || state != State.LIVE) return@post
            source = if (useNodes) Source.NODES else Source.OCR
            signature = nodes?.signature ?: 0
            frameId = f.id
            if (BuildConfig.DEBUG) android.util.Log.i("LavaTranslate", "live scan ${source.name.lowercase()} lines=${lines.length()} capture=${captureMs}ms read=${readMs}ms unknown=${nodes?.unknown}")
            overlay?.bridge?.emit(
                "live.frame", JSONObject()
                    .put("frame", JSONObject().put("id", f.id).put("w", f.width).put("h", f.height).put("content", rect(c)))
                    .put("lines", lines)
                    .put("image", image)
                    .put("source", source.name.lowercase())
            )
        }
    }

    /** 同一个错误（例如没填 Key）在一次实时翻译里只提示一次，不要每滑一下就弹 */
    private var lastError = ""

    private fun liveError(message: String) {
        capsuleView?.busy(false)
        if (message == lastError) return
        lastError = message
        toast(message)
    }

    /** 译文层显示与否：只改窗口透明度 */
    private fun layer(on: Boolean) {
        layerOn = on
        val o = overlay ?: return
        if (o.attached && o.passthrough) o.passthrough(on && !peeking)
    }

    private fun peek(on: Boolean) {
        peeking = on
        val o = overlay ?: return
        if (o.attached && o.passthrough) o.passthrough(layerOn && !on)
    }

    // ------------------------------------------------------------ 界面事件（只在实时翻译时订阅）
    private val settle = Runnable { scan() }
    private val contentCheck = Runnable { checkContent() }

    private fun subscribe(on: Boolean) {
        val info = svc.serviceInfo ?: return
        info.eventTypes = if (on) AccessibilityEvent.TYPE_VIEW_SCROLLED or AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED else 0
        info.notificationTimeout = if (on) 50 else 0
        svc.serviceInfo = info
        // 读过节点后系统会让应用为缓存持续发送界面变化；不翻译时关掉缓存，应用就不再发（Android 13+）
        if (!on && Build.VERSION.SDK_INT >= 33) svc.setCacheEnabled(false)
        if (on && Build.VERSION.SDK_INT >= 33) svc.setCacheEnabled(true)
    }

    fun onEvent(e: AccessibilityEvent) {
        if (state != State.LIVE || replying) return
        val pkg = e.packageName?.toString() ?: return
        // 自己的窗口、状态栏（时钟、通知图标）的变化不算
        if (pkg == svc.packageName || pkg == "com.android.systemui") return
        when (e.eventType) {
            AccessibilityEvent.TYPE_VIEW_SCROLLED, AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> moved(SETTLE_MS)
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
                // 正在等滑动停下时不管；否则过一会儿看看文字变没变（视频、动画一直在变，只看文字）
                if (!main.hasCallbacks(settle)) {
                    main.removeCallbacks(contentCheck)
                    main.postDelayed(contentCheck, CONTENT_MS)
                }
            }
        }
    }

    /** 画面在动：立刻藏起译文、停下翻译，等停下来再读屏 */
    private fun moved(wait: Long) {
        if (layerOn || main.hasCallbacks(settle).not()) {
            scanGen++
            layer(false)
            overlay?.bridge?.emit("live.hide")
            capsuleView?.busy(false)
        }
        main.removeCallbacks(contentCheck)
        main.removeCallbacks(settle)
        main.postDelayed(settle, wait)
    }

    /** 不发界面事件的应用（游戏、自绘界面，用 OCR 的）：碰了屏幕就当它可能在动 */
    private fun touchedOutside() {
        if (state == State.LIVE && !replying && source == Source.OCR) moved(OCR_SETTLE_MS)
    }

    private fun checkContent() {
        if (state != State.LIVE || replying || source != Source.NODES) return
        val gen = scanGen
        app.worker.execute {
            val size = Screen.size(svc)
            val sig = runCatching { NodeText.read(svc, Screen.content(svc, size.x, size.y), density).signature }.getOrNull() ?: return@execute
            main.post { if (gen == scanGen && sig != signature) scan() }
        }
    }

    // ------------------------------------------------------------ 回复
    /** 面板上的「回复」，或下拉快捷开关「快捷回复」：输入翻译，不截屏 */
    fun quick() {
        if (locked || state == State.LIVE || state == State.QUICK) return
        afterQuick = state
        state = State.QUICK
        main.removeCallbacks(releaseTask)
        panel?.dismiss()
        val o = overlay()
        o.attach()
        o.bridge.emit("open", openMsg("quick"))
        main.postDelayed({ if (state == State.QUICK && overlay?.visible == false) endQuick() }, if (webReady) 4000L else 12000L)
    }

    private fun endQuick() {
        if (state != State.QUICK) return
        overlay?.detach()
        state = afterQuick
        if (state == State.PANEL) showPanelWindow()
        scheduleRelease()
    }

    /** 小胶囊上的「回复」：用屏幕上的对话当上下文 */
    private fun reply() {
        if (state != State.LIVE || replying) return
        replying = true
        main.removeCallbacks(settle)
        main.removeCallbacks(contentCheck)
        overlay?.reveal()
        overlay?.bridge?.emit("live.reply")
        main.postDelayed({ overlay?.showKeyboard() }, 220)
    }

    private fun replyClosed() {
        if (!replying) return
        replying = false
        overlay?.passthrough(layerOn && !peeking)
        // 回复期间屏幕可能变了（发出去的消息）：重新读一次
        if (state == State.LIVE) moved(SETTLE_MS)
    }

    // ------------------------------------------------------------ 翻译界面（网页）
    private fun overlay(): OverlayHost = overlay ?: OverlayHost(svc, wm, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, ::handle).also {
        overlay = it
        webReady = false
    }

    /** 面板出现时先把网页载入好，点「翻译」时不用再等 */
    private fun prewarm() {
        main.removeCallbacks(releaseTask)
        overlay()
        scheduleRelease()
    }

    private fun openMsg(mode: String): JSONObject {
        val d = density
        return JSONObject()
            .put("mode", mode)
            .put("host", "a11y")
            .put("bubble", false)
            .put("density", d)
            .put("orb", JSONObject().put("x", 0).put("y", 0).put("size", 52))
            .put("side", app.settings.str("capsuleSide").ifEmpty { "right" })
            .put("insets", JSONObject()
                .put("top", Screen.content(svc, 1, Screen.size(svc).y).top / d)
                .put("bottom", Screen.navBottom(svc) / d))
            .put("settings", app.settings.plain())
    }

    private fun handle(m: String, a: JSONObject, reply: Bridge.Reply) {
        val o = overlay ?: return reply.err("翻译界面已关闭")
        when (m) {
            "hello" -> {
                webReady = true
                if (!o.attached) app.webVisible(o.web, false)
                reply.ok(JSONObject().put("version", BuildConfig.VERSION_NAME))
            }
            // 输入翻译：网页画好后再显示、弹键盘
            "shown" -> {
                if (state == State.QUICK) {
                    o.reveal()
                    main.postDelayed({ o.showKeyboard() }, 160)
                }
                reply.ok()
            }
            "close" -> {
                reply.ok()
                main.post { endQuick() }
            }
            /** 这一帧的译文（缓存的或第一段新译文）画好了：显示译文层 */
            "live.visible" -> {
                reply.ok()
                main.post { if (state == State.LIVE && a.optInt("frame") == frameId && !main.hasCallbacks(settle)) layer(true) }
            }
            "live.state" -> {
                reply.ok()
                main.post {
                    if (state != State.LIVE) return@post
                    val phase = a.optString("phase")
                    capsuleView?.busy(phase == "translating")
                    if (phase == "error") liveError(a.optString("message").ifEmpty { "翻译失败" })
                }
            }
            "live.replyClosed" -> {
                reply.ok()
                main.post { replyClosed() }
            }
            "openSettings" -> {
                reply.ok()
                main.post {
                    if (state == State.LIVE) stopLive()
                    if (state == State.QUICK) endQuick()
                    openSettings()
                }
            }
            else -> if (!CommonBridge.handle(svc, o.root, o.bridge, m, a, reply)) reply.err("unknown method $m")
        }
    }

    // ------------------------------------------------------------ 释放、锁屏
    private val releaseTask = Runnable { release() }

    private fun scheduleRelease() {
        main.removeCallbacks(releaseTask)
        main.postDelayed(releaseTask, WARM_MS)
    }

    /** 释放网页和 OCR 模型（下次用时再载入） */
    fun release() {
        main.removeCallbacks(releaseTask)
        if (active) return
        overlay?.destroy()
        overlay = null
        webReady = false
        app.worker.execute { app.ocr.close() }
    }

    private val screen = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    locked = true
                    if (state == State.LIVE) stopLive()
                    if (state == State.QUICK) endQuick()
                    panel?.dismiss()
                    release()
                    scheduleRecycle()
                }
                Intent.ACTION_SCREEN_ON -> {
                    alarms.cancel(recycle)
                    if (!context.getSystemService(KeyguardManager::class.java).isKeyguardLocked) unlocked()
                }
                Intent.ACTION_USER_PRESENT -> unlocked()
            }
        }
    }

    /**
     * 网页释放后，网页引擎本身还占着一两百 MB，只有结束进程才能还给系统（系统会以只带本服务的小进程重新拉起）。
     * 但重新拉起有延迟（反复结束时越来越长，可能几十秒），期间点图标没反应——所以只在关屏很久后才做，用户碰不到
     */
    private val alarms = svc.getSystemService(android.app.AlarmManager::class.java)
    private val recycle = android.app.AlarmManager.OnAlarmListener {
        if (!svc.getSystemService(android.os.PowerManager::class.java).isInteractive && !active && app.webEngineLoaded) app.endProcessSoon()
    }

    private fun scheduleRecycle() {
        alarms.cancel(recycle)
        if (app.webEngineLoaded) alarms.setWindow(android.app.AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + RECYCLE_MS, 10 * 60_000L, "lava:recycle", recycle, main)
    }

    private fun unlocked() {
        locked = false
        showPanelWindow()
    }

    init {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        // 要 EXPORTED：解锁广播由系统界面（另一个应用）发出；三个都是受保护的系统广播，别的应用发不了
        ContextCompat.registerReceiver(app, screen, filter, ContextCompat.RECEIVER_EXPORTED)
        // 进程被系统回收后重新拉起：面板之前开着就恢复
        if (app.settings.bool("panelOpen")) {
            state = State.PANEL
            showPanelWindow()
        }
        if (Build.VERSION.SDK_INT >= 33) svc.setCacheEnabled(false)
    }

    fun onConfigurationChanged() {
        if (panel?.showing == true) {
            panel?.dismiss()
            showPanelWindow()
        }
        if (capsule?.showing == true) {
            capsule?.dismiss()
            showCapsule()
            if (state == State.LIVE) moved(SETTLE_MS)
        }
    }

    fun destroy() {
        alarms.cancel(recycle)
        runCatching { app.unregisterReceiver(screen) }
        main.removeCallbacksAndMessages(null)
        panel?.dismiss()
        capsule?.dismiss()
        overlay?.destroy()
        overlay = null
        FrameStore.current = null
        app.worker.execute { app.ocr.close() }
    }

    /** 前两次进入实时翻译时说明小胶囊的用法 */
    private fun tips() {
        val n = app.settings.num("capsuleTips").let { if (it.isNaN()) 0 else it.toInt() }
        if (n >= 2) return
        app.settings.update(JSONObject().put("capsuleTips", n + 1))
        toast("滑动时译文自动藏起，停下就重新翻译 · 按住 👁 看原文")
    }

    private fun toast(text: String) = main.post { Toast.makeText(svc, text, Toast.LENGTH_SHORT).show() }

    companion object {
        /** 滑动停下多久后重新读屏 */
        private const val SETTLE_MS = 450L
        /** 用 OCR 的界面没有事件，碰了屏幕后多等一会儿 */
        private const val OCR_SETTLE_MS = 800L
        /** 界面内容变化（不是滑动）后多久检查文字有没有变 */
        private const val CONTENT_MS = 700L
        /** 翻译界面和 OCR 模型用完后再留这么久 */
        const val WARM_MS = 3 * 60_000L
        /** 关屏这么久后结束进程，把网页引擎占的内存还给系统 */
        private const val RECYCLE_MS = 30 * 60_000L

        private fun rect(r: Rect) = JSONObject().put("x", r.left).put("y", r.top).put("w", r.width()).put("h", r.height())
    }
}
