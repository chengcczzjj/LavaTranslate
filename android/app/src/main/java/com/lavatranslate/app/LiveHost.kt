package com.lavatranslate.app

import android.app.AlarmManager
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
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
import com.lavatranslate.app.ui.PanelBar
import com.lavatranslate.app.ui.PlainWindow
import com.lavatranslate.app.update.Updater
import com.lavatranslate.app.web.Bridge
import com.lavatranslate.app.web.CommonBridge
import com.lavatranslate.app.web.FrameStore
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Callable
import java.util.concurrent.Future
import kotlin.math.roundToInt

/**
 * 无障碍模式的界面（整个都在无障碍服务里，见 LavaAccessibilityService）：
 *
 * - **面板**：点 LavaTranslate 图标（或系统无障碍按钮）从屏幕上方弹下的一条毛玻璃横条：翻译 / 回复 / 设置，最右边关闭；
 * - **翻译**：点「翻译」面板收起，屏幕边上出现小胶囊；整屏译文盖在截图上（和原来的屏幕一模一样），小胶囊始终在它上面。
 *   译文是穿透的：触摸、返回键照常交给下面的应用。手指一碰屏幕（小胶囊的窗口外触摸）译文立刻让开，同一下就滑动、点按了应用；
 *   应用滚动、换页停下 [SETTLE_MS] 后自动重新翻译整屏，翻过的内容走网页里的缓存，立刻出现；只是点了一下、屏幕没变时，
 *   [TOUCH_SETTLE_MS] 后把刚才的译文原样放回来。
 *   文字优先直接从无障碍节点读（每个字的位置都有时，比 OCR 快、准），否则截图做 OCR；
 *   小胶囊：按住「对比」看原文；译文收起时它变成「翻译」，点一下马上重新翻译；「回复」写回复；「退出」回到面板；
 * - **回复**：面板上的「回复」、快捷开关「快捷回复」，或译文收起时胶囊上的「回复」：输入翻译；
 *   译文显示时胶囊上的「回复」打开带对话上下文的回复框。写回复时小胶囊让开。
 *
 * 只在译文收起、等应用停下时订阅界面事件；不翻译时没有任何事件、动画和后台工作。
 * 翻译界面的网页在面板出现时预先载入，用完（或面板空闲）[WARM_MS] 后释放；锁屏时什么都不显示。
 */
class LiveHost(private val svc: LavaAccessibilityService) {
    private enum class State { HIDDEN, PANEL, LIVE, QUICK }

    /** 翻译中的阶段：正在截屏和准备 → 译文显示中 → 译文让开了（等应用停下） */
    private enum class Phase { CAPTURING, SHOWN, AWAY }

    private val app get() = LavaApp.instance
    private val main = Handler(Looper.getMainLooper())
    private val wm = svc.getSystemService(WindowManager::class.java)
    private val density = svc.resources.displayMetrics.density
    private val capturer = A11yCapturer(svc)

    private var state = State.HIDDEN
    private var phase = Phase.AWAY
    /** 回复框关掉后回到哪个状态 */
    private var afterQuick = State.HIDDEN

    private var panel: GlassWindow? = null
    private var panelView: PanelBar? = null
    private var capsule: PlainWindow? = null
    private var capsuleView: CapsuleView? = null
    private var overlay: OverlayHost? = null
    private var webReady = false

    /** 设置页开着：面板先藏起来 */
    private var settingsShown = false

    /** 锁屏界面在显示：自己记状态（解锁广播到达时 isKeyguardLocked 有时还是 true） */
    private var locked = svc.getSystemService(KeyguardManager::class.java).isKeyguardLocked

    // ------------------------------------------------------------ 这一屏的文字
    private var scanGen = 0
    private var textJob: Future<JSONObject>? = null
    private var imageJob: Future<JSONObject>? = null
    private var frameId = 0
    /** 一帧截图时节点文字的指纹：译文被碰走后用来判断屏幕变没变（一个文字节点都没有时不记） */
    private class Sig(val frame: Int, val value: Int, val content: Rect)
    @Volatile private var sig: Sig? = null
    /** 收起之后应用滚动过 */
    private var scrolled = false
    /** 这之前的「窗口状态变化」是自己换焦点引起的，不算 */
    private var quietUntil = 0L
    /** 译文是被手指碰走的（网页里还是这一屏的译文）：屏幕没变就直接放回来，不用重新截屏 */
    private var restorable = false
    /** 这一屏翻译完了 */
    private var done = false

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
        slideUp { panel?.dismiss() }
        scheduleRelease()
    }

    private val margin get() = (10 * density).roundToInt()

    private fun showPanelWindow() {
        if (locked || settingsShown || state != State.PANEL) return
        val size = Screen.size(svc)
        val width = size.x - margin * 2
        val v = panelView ?: PanelBar(svc, onTranslate = { startLive() }, onReply = { quick() }, onSettings = { openSettings() }, onClose = { closePanel() }).also { panelView = it }
        val g = panel ?: GlassWindow(svc, v, 17f, width, horizontalDrag = false, onMoved = { _, y -> savePanel(y) }).also { panel = it }
        if (g.showing) return
        val (_, h) = g.measure()
        val top = Screen.content(svc, size.x, size.y).top + (6 * density).roundToInt()
        val fy = app.settings.num("panelY")
        val y = if (fy.isNaN()) top else clampY((fy * size.y).roundToInt(), h)
        g.show(margin, y)
        // 从上面滑下来
        v.alpha = 0f
        v.translationY = -h.toFloat()
        v.animate().alpha(1f).translationY(0f).setDuration(260).setInterpolator(android.view.animation.DecelerateInterpolator(2f)).start()
    }

    private fun slideUp(end: () -> Unit) {
        val v = panelView ?: return end()
        if (panel?.showing != true) return end()
        v.animate().alpha(0f).translationY(-v.height.toFloat()).setDuration(180).setInterpolator(android.view.animation.AccelerateInterpolator(1.5f)).withEndAction(end).start()
    }

    private fun savePanel(y: Int) {
        val g = panel ?: return
        val (_, h) = g.measure()
        val cy = clampY(y, h)
        g.move(margin, cy)
        app.settings.update(JSONObject().put("panelY", cy.toDouble() / Screen.size(svc).y))
    }

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
    /** 要在翻译界面之后加上去，才会在它上面 */
    private fun showCapsule() {
        val v = capsuleView ?: CapsuleView(svc, onCompare = { peek(it) }, onTranslate = { translate() }, onReply = { capsuleReply() }, onExit = { stopLive() }).also { capsuleView = it }
        val g = capsule ?: PlainWindow(svc, v) { x, y -> snapCapsule(x, y) }.also {
            it.onOutside = { touched() }
            capsule = it
        }
        if (locked) return
        g.dismiss()
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

    // ------------------------------------------------------------ 翻译
    /** 面板上的「翻译」，或下拉快捷开关「翻译屏幕」 */
    fun startLive() {
        if (locked || state == State.LIVE || state == State.QUICK) return
        val fromPanel = state == State.PANEL && panel?.showing == true
        state = State.LIVE
        phase = Phase.AWAY
        app.settings.update(JSONObject().put("panelOpen", true))
        main.removeCallbacks(releaseTask)
        val begin = {
            // 面板拿过焦点的话，收起时应用会发一次「窗口状态变化」
            quietUntil = SystemClock.uptimeMillis() + 600
            panel?.dismiss()
            // 翻译界面先挂上（透明、不接触摸），小胶囊后加，保证在它上面
            overlay().attach()
            showCapsule()
            translate()
        }
        // 面板收上去之后再截屏（不能把面板截进去）
        if (fromPanel) slideUp(begin) else begin()
        tips()
    }

    /** 截屏、读文字，交给网页画出截图和译文 */
    private fun translate() {
        if (state != State.LIVE || phase == Phase.CAPTURING) return
        phase = Phase.CAPTURING
        // 截屏、读文字的时候应用换了页（例如刚点开的页面还在过场动画）：这张截图作废，等停稳了再截
        subscribe(EVENTS_SHOWN)
        main.removeCallbacks(settle)
        main.removeCallbacks(waitingIcon)
        done = false
        val gen = ++scanGen
        capsuleView?.waiting(false)
        capsuleView?.busy(true)
        val o = overlay()
        if (o.visible) o.conceal(pauseWeb = false)
        o.attach()
        val mask = capsuleRect()
        // 等两帧：确保收起的译文已经从屏幕上消失，不会被截进去
        val ch = Choreographer.getInstance()
        ch.postFrameCallback { ch.postFrameCallback { app.worker.execute { capture(gen, mask) } } }
        main.postDelayed({ if (gen == scanGen && phase == Phase.CAPTURING) away() }, if (webReady) 6000L else 14000L)
    }

    private fun capture(gen: Int, mask: Rect?) {
        val t0 = SystemClock.elapsedRealtime()
        val f = try {
            capturer.capture()
        } catch (e: CaptureException) {
            // 截屏太频繁（系统限制每秒约 3 次）：稍等再来
            if (e.message?.contains("频繁") == true) main.postDelayed({ if (gen == scanGen) retry() }, 400)
            else main.post { if (gen == scanGen) fail(e.message ?: "截屏失败") }
            return
        }
        if (gen != scanGen) return
        val captureMs = SystemClock.elapsedRealtime() - t0
        if (mask != null) f.fill(mask)
        FrameStore.current = f
        if (BuildConfig.DEBUG) FrameStore.last = f
        val c = f.content
        val crop = f.crop(c)
        textJob = app.worker.submit(Callable { readText(f, crop, captureMs) })
        imageJob = app.worker.submit(Callable { ScreenHost.encodeForModel(crop, c.width(), c.height()) })
        main.post {
            if (gen != scanGen || state != State.LIVE) return@post
            frameId = f.id
            overlay?.bridge?.emit("open", openMsg("translate").put("frame", JSONObject().put("id", f.id).put("w", f.width).put("h", f.height).put("content", rect(c))))
        }
    }

    private fun retry() {
        phase = Phase.AWAY
        translate()
    }

    /** 文字：每个字的位置都读得到就直接用节点，否则做 OCR（与截屏授权模式同一种格式） */
    private fun readText(f: Frame, crop: ByteArray, captureMs: Long): JSONObject {
        val c = f.content
        val t0 = SystemClock.elapsedRealtime()
        val nodes = runCatching { NodeText.read(svc, c, density) }.getOrNull()
        val lines = JSONArray()
        // 一个文字节点都没有（游戏、视频）时指纹没有意义
        sig = if (nodes != null && (nodes.lines.isNotEmpty() || nodes.unknown > 0)) Sig(f.id, nodes.signature, Rect(c)) else null
        val source = if (nodes != null && nodes.lines.isNotEmpty() && nodes.unknown == 0) {
            nodes.lines.forEachIndexed { i, l ->
                lines.put(JSONObject().put("id", i + 1).put("text", l.text).put("score", 1)
                    .put("box", JSONObject().put("x", l.box.left - c.left).put("y", l.box.top - c.top).put("w", l.box.width()).put("h", l.box.height())))
            }
            "nodes"
        } else {
            app.ocr.recognize(crop, c.width(), c.height()).forEach { lines.put(it.json()) }
            "ocr"
        }
        val ms = SystemClock.elapsedRealtime() - t0
        if (BuildConfig.DEBUG) android.util.Log.i("LavaTranslate", "scan $source lines=${lines.length()} capture=${captureMs}ms read=${ms}ms unknown=${nodes?.unknown}")
        return JSONObject()
            .put("frame", f.id)
            .put("lines", lines)
            .put("ms", ms)
            .put("source", source)
            .put("timing", JSONObject().put("capture", captureMs).put("read", ms))
    }

    private fun fail(message: String) {
        capsuleView?.busy(false)
        toast(message)
        away()
    }

    /**
     * 译文收起（手指碰了屏幕、应用换了页、返回键）：透明、不接触摸，等应用停下后自动重新翻译。
     * settleMs > 0：没有事件也在这么久后检查一次（只是点了一下、什么都没变时把译文放回来）
     */
    private fun away(settleMs: Long = 0, restore: Boolean = false) {
        if (state != State.LIVE) return
        scanGen++
        phase = Phase.AWAY
        scrolled = false
        restorable = restore
        if (overlay?.touchable == true) quietUntil = SystemClock.uptimeMillis() + 600
        overlay?.conceal()
        if (capsule?.showing != true) showCapsule()
        capsuleView?.busy(false)
        subscribe(EVENTS_AWAY)
        main.removeCallbacks(settle)
        main.removeCallbacks(waitingIcon)
        // 只是点了一下的话马上就放回来：图标晚一点再变成「翻译」，免得闪
        if (settleMs > 0) {
            main.postDelayed(settle, settleMs)
            main.postDelayed(waitingIcon, 900)
        } else capsuleView?.waiting(true)
    }

    private val waitingIcon = Runnable { if (state == State.LIVE && phase == Phase.AWAY) capsuleView?.waiting(true) }

    /** 手指碰了屏幕（小胶囊以外的地方；这一下照常交给下面的应用）：译文立刻让开，停下后再翻 */
    private fun touched() {
        if (state != State.LIVE) return
        dbg("touched $phase touchable=${overlay?.touchable}")
        when (phase) {
            // 译文可交互（回复框、出错提示）时碰的是译文本身，不算
            Phase.SHOWN -> if (overlay?.touchable != true) away(TOUCH_SETTLE_MS, restore = true)
            // 截屏、读文字的时候碰了：这张截图可能已经过时
            Phase.CAPTURING -> away(TOUCH_SETTLE_MS)
            Phase.AWAY -> {
                main.removeCallbacks(settle)
                main.postDelayed(settle, TOUCH_SETTLE_MS)
            }
        }
    }

    /** 屏幕没变：把刚才的译文放回来（网页里还在，不用重新截屏） */
    private fun restore() {
        val o = overlay ?: return translate()
        phase = Phase.SHOWN
        subscribe(EVENTS_SHOWN)
        main.removeCallbacks(waitingIcon)
        o.reveal(touch = false)
        capsuleView?.waiting(false)
        capsuleView?.busy(!done)
    }

    private fun peek(on: Boolean) {
        if (state == State.LIVE && phase == Phase.SHOWN) overlay?.peek(on)
    }

    /** 小胶囊上的「退出」：回到面板 */
    fun stopLive(toPanel: Boolean = true) {
        if (state != State.LIVE) return
        subscribe(0)
        main.removeCallbacks(settle)
        scanGen++
        overlay?.detach()
        FrameStore.current = null
        textJob = null
        imageJob = null
        capsuleView?.busy(false)
        capsule?.dismiss()
        state = if (toPanel) State.PANEL else State.HIDDEN
        if (toPanel) showPanelWindow()
        scheduleRelease()
        Updater.autoCheck(svc, 20 * 3600_000L)
    }

    // ------------------------------------------------------------ 界面事件（只在译文收起、等应用停下时订阅）
    private val settle = Runnable { settled() }

    /**
     * 应用停下来了：重新翻译。只是点了一下、没滚动时，先看看节点文字有没有变：没变就把刚才的译文放回来，不用重新截屏
     */
    private fun settled() {
        val s = sig
        dbg("settled restorable=$restorable scrolled=$scrolled sig=${s?.frame} frame=$frameId")
        if (!restorable || scrolled || s == null || s.frame != frameId) return translate()
        val gen = scanGen
        app.worker.execute {
            val now = runCatching { NodeText.read(svc, s.content, density) }.getOrNull()
            main.post {
                if (gen != scanGen || state != State.LIVE || phase != Phase.AWAY) return@post
                if (now != null && now.signature == s.value) {
                    if (BuildConfig.DEBUG) android.util.Log.i("LavaTranslate", "settle: unchanged, restore")
                    restore()
                } else translate()
            }
        }
    }

    private fun subscribe(types: Int) {
        val info = svc.serviceInfo ?: return
        if (info.eventTypes == types) return
        info.eventTypes = types
        info.notificationTimeout = if (types != 0) 50 else 0
        svc.serviceInfo = info
    }

    fun onEvent(e: AccessibilityEvent) {
        if (state != State.LIVE) return
        val pkg = e.packageName?.toString() ?: return
        // 自己的窗口、状态栏（时钟、通知图标）的变化不算
        if (pkg == svc.packageName || pkg == "com.android.systemui") return
        // 输入法弹出、收起（例如回复框关掉）也会发「窗口状态变化」
        if (pkg == Settings.Secure.getString(svc.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)?.substringBefore('/')) return
        // 译文层交出焦点（回复框收起）时应用会发一次「窗口状态变化」，不算
        if (e.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && e.eventTime < quietUntil) return
        when (phase) {
            // 译文显示着、应用自己换了页（返回键、弹窗）：收起，没变的话放回来
            Phase.SHOWN -> {
                if (e.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && overlay?.touchable != true) away(SETTLE_MS, restore = true)
                return
            }
            Phase.CAPTURING -> {
                if (e.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) away(SETTLE_MS)
                return
            }
            Phase.AWAY -> {}
        }
        if (e.eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED) scrolled = true
        // 应用在滚动、换页：等它停下来再翻译
        main.removeCallbacks(settle)
        main.postDelayed(settle, SETTLE_MS)
    }

    // ------------------------------------------------------------ 回复
    /** 面板上的「回复」，或下拉快捷开关「快捷回复」：输入翻译，不截屏 */
    fun quick() {
        if (locked || state == State.QUICK) return
        if (state == State.LIVE && phase != Phase.AWAY) return
        afterQuick = state
        state = State.QUICK
        main.removeCallbacks(releaseTask)
        main.removeCallbacks(settle)
        subscribe(0)
        panel?.dismiss()
        // 小胶囊会挡住回复框：写完回到「译文收起」时再放回来
        capsule?.dismiss()
        val o = overlay()
        o.attach()
        o.bridge.emit("open", openMsg("quick"))
        main.postDelayed({ if (state == State.QUICK && overlay?.visible == false) endQuick() }, if (webReady) 4000L else 12000L)
    }

    private fun endQuick() {
        if (state != State.QUICK) return
        state = afterQuick
        when (state) {
            // 翻译中写完回复：回到「译文收起」，翻译界面继续挂着（小胶囊要在它上面）
            State.LIVE -> away()
            else -> {
                overlay?.detach()
                if (state == State.PANEL) showPanelWindow()
                scheduleRelease()
            }
        }
    }

    /** 小胶囊上的「回复」：译文显示着就在译文界面里写（用屏幕上的对话当上下文），否则打开输入翻译 */
    private fun capsuleReply() {
        if (state != State.LIVE) return
        when (phase) {
            Phase.SHOWN -> {
                val o = overlay ?: return
                capsule?.dismiss()
                o.reveal(touch = true)
                o.bridge.emit("reply")
                main.postDelayed({ overlay?.showKeyboard() }, 220)
            }
            Phase.AWAY -> quick()
            Phase.CAPTURING -> {}
        }
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
        val c = capsuleRect()
        return JSONObject()
            .put("mode", mode)
            .put("host", "a11y")
            .put("bubble", false)
            .put("density", d)
            .put("orb", JSONObject().put("x", (c?.left ?: 0) / d).put("y", (c?.top ?: 0) / d).put("size", 52))
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
                // 挂着（正在截屏、马上要显示）时不暂停，否则冷启动的第一次翻译画不出来
                if (!o.attached) app.webVisible(o.web, false)
                reply.ok(JSONObject().put("version", BuildConfig.VERSION_NAME))
            }
            // 网页画好了（截图或回复框）：显示出来
            "shown" -> {
                reply.ok()
                main.post {
                    when (state) {
                        State.LIVE -> if (phase == Phase.CAPTURING) {
                            dbg("shown")
                            // 穿透：看得见，触摸照常交给下面的应用（手指一碰小胶囊就知道，见 touched）
                            o.reveal(touch = false)
                            phase = Phase.SHOWN
                            subscribe(EVENTS_SHOWN)
                            // 窗口拿到焦点后可能被系统挪到上层：小胶囊重新放到最上面
                            if (capsule?.showing != true) showCapsule()
                        }
                        State.QUICK -> {
                            o.reveal()
                            main.postDelayed({ o.showKeyboard() }, 160)
                        }
                        else -> {}
                    }
                }
            }
            "ocr" -> {
                val job = textJob
                val img = imageJob
                if (job == null || img == null) return reply.err("截图已失效，请重新截图")
                app.worker.execute {
                    try {
                        val r = job.get()
                        if (r.optInt("frame") != a.optInt("frame")) return@execute reply.err("截图已失效，请重新截图")
                        reply.ok(JSONObject(r.toString()).put("image", img.get()))
                    } catch (e: Exception) {
                        reply.err("文字识别失败：${e.cause?.message ?: e.message}")
                    }
                }
            }
            /** 网页里滑了一下、按了返回键（关闭）：收起译文 */
            "swipe", "close" -> {
                reply.ok()
                main.post {
                    when (state) {
                        State.LIVE -> away()
                        State.QUICK -> endQuick()
                        else -> {}
                    }
                }
            }
            "translated" -> {
                reply.ok()
                // 出错且提示上有按钮（去设置、重试）：让译文可以点；重试成功后再回到穿透
                val err = a.optString("error")
                main.post {
                    done = true
                    capsuleView?.busy(false)
                    if (state != State.LIVE || phase != Phase.SHOWN || capsule?.showing != true) return@post
                    if (err.isNotEmpty() && err != "no-text") o.reveal(touch = true)
                    else if (o.touchable) {
                        quietUntil = SystemClock.uptimeMillis() + 600
                        o.reveal(touch = false)
                    }
                }
            }
            /** 译文上的回复框开关：打开时收起小胶囊，免得挡住回复框 */
            "composer" -> {
                reply.ok()
                val open = a.optBoolean("open")
                main.post {
                    if (state != State.LIVE) return@post
                    if (open) {
                        capsule?.dismiss()
                        return@post
                    }
                    // 回复框收起：译文回到穿透
                    if (phase == Phase.SHOWN && o.touchable) {
                        quietUntil = SystemClock.uptimeMillis() + 600
                        o.reveal(touch = false)
                    }
                    if (capsule?.showing != true) showCapsule()
                }
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
                    if (state == State.QUICK) endQuick()
                    if (state == State.LIVE) stopLive()
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
    private val alarms = svc.getSystemService(AlarmManager::class.java)
    private val recycle = AlarmManager.OnAlarmListener {
        if (!svc.getSystemService(PowerManager::class.java).isInteractive && !active && app.webEngineLoaded) app.endProcessSoon()
    }

    private fun scheduleRecycle() {
        alarms.cancel(recycle)
        if (app.webEngineLoaded) alarms.setWindow(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + RECYCLE_MS, 10 * 60_000L, "lava:recycle", recycle, main)
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
        // 读过节点后系统会让应用为缓存持续发送界面变化；关掉缓存，应用就只发我们订阅的事件（Android 13+）
        if (Build.VERSION.SDK_INT >= 33) svc.setCacheEnabled(false)
    }

    fun onConfigurationChanged() {
        if (panel?.showing == true) {
            panel?.dismiss()
            panel = null
            showPanelWindow()
        }
        if (capsule?.showing == true) showCapsule()
        // 转屏：之前的截图对不上了，收起译文
        if (state == State.LIVE && phase == Phase.SHOWN) away()
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

    /** 前两次翻译时说明用法 */
    private fun tips() {
        val n = app.settings.num("capsuleTips").let { if (it.isNaN()) 0 else it.toInt() }
        if (n >= 2) return
        app.settings.update(JSONObject().put("capsuleTips", n + 1))
        toast("照常滑动、点按，译文会自动让开，停下后重新翻译 · 按住 👁 看原文")
    }

    private fun dbg(msg: String) {
        if (BuildConfig.DEBUG) android.util.Log.i("LavaTranslate", "live: $msg")
    }

    private fun toast(text: String) = main.post { Toast.makeText(svc, text, Toast.LENGTH_SHORT).show() }

    companion object {
        /** 应用滚动、换页停下多久后重新翻译 */
        private const val SETTLE_MS = 450L
        /** 手指碰了屏幕、之后没有任何事件：这么久后检查屏幕变没变 */
        private const val TOUCH_SETTLE_MS = 700L
        /** 截屏和译文显示时只听换页（返回键、弹窗、过场动画）；收起后再听滚动 */
        private const val EVENTS_SHOWN = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        private const val EVENTS_AWAY = AccessibilityEvent.TYPE_VIEW_SCROLLED or AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        /** 翻译界面和 OCR 模型用完后再留这么久 */
        const val WARM_MS = 3 * 60_000L
        /** 关屏这么久后结束进程，把网页引擎占的内存还给系统 */
        private const val RECYCLE_MS = 30 * 60_000L

        private fun rect(r: Rect) = JSONObject().put("x", r.left).put("y", r.top).put("w", r.width()).put("h", r.height())
    }
}
