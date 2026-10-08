package com.lavatranslate.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.FrameLayout
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import com.lavatranslate.app.web.Bridge
import com.lavatranslate.app.web.createWebView
import org.json.JSONObject

/**
 * 全屏翻译界面：一个覆盖全屏的窗口，里面是 WebView（overlay.html）。窗口类型由宿主决定：
 * 无障碍图层（无障碍服务）或悬浮窗（悬浮球服务）。用时才创建，用完一段时间后由 [ScreenHost] 释放。
 * 平时不挂到屏幕上（透明的全屏窗口也会让部分应用认为被遮挡），网页也暂停着；要用时先以透明度 0 挂上，
 * 网页把截图画好后通知 shown，再变为可见——看起来和原来的屏幕完全一样，然后译文就地浮现。
 */
@SuppressLint("ViewConstructor")
class OverlayHost(ctx: Context, private val wm: WindowManager, private val windowType: Int, handle: (String, JSONObject, Bridge.Reply) -> Unit) {
    private val density = ctx.resources.displayMetrics.density
    private var backCallback: Any? = null

    val root: FrameLayout = object : FrameLayout(ctx) {
        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            if (event.keyCode == KeyEvent.KEYCODE_BACK) {
                if (event.action == KeyEvent.ACTION_UP) bridge.emit("back")
                return true
            }
            return super.dispatchKeyEvent(event)
        }
    }
    val web = createWebView(ctx, "overlay.html", transparent = true)
    val bridge = Bridge(web, handle)

    var attached = false
        private set
    var visible = false
        private set
    /** 接触摸（可交互）；看得见但不接触摸时，触摸和返回键都交给下面的应用（无障碍模式的译文） */
    var touchable = false
        private set

    init {
        root.addView(web, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        root.isFocusable = true
        root.isFocusableInTouchMode = true
        root.setOnApplyWindowInsetsListener { _, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val ime = insets.getInsets(WindowInsets.Type.ime()).bottom
                val top = insets.getInsets(WindowInsets.Type.statusBars() or WindowInsets.Type.displayCutout()).top
                val bottom = insets.getInsets(WindowInsets.Type.navigationBars()).bottom
                bridge.emit("insets", JSONObject().put("ime", ime / density).put("top", top / density).put("bottom", bottom / density))
            }
            insets
        }
        root.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) {
                // Android 13 起返回手势走 OnBackInvokedCallback
                if (Build.VERSION.SDK_INT >= 33) {
                    val cb = OnBackInvokedCallback { bridge.emit("back") }
                    v.findOnBackInvokedDispatcher()?.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_OVERLAY, cb)
                    backCallback = cb
                }
            }

            override fun onViewDetachedFromWindow(v: View) {
                if (Build.VERSION.SDK_INT >= 33) (backCallback as? OnBackInvokedCallback)?.let { v.findOnBackInvokedDispatcher()?.unregisterOnBackInvokedCallback(it) }
                backCallback = null
            }
        })
    }

    private fun params(show: Boolean, alpha: Float = if (show) 1f else 0f, touch: Boolean = show) = WindowManager.LayoutParams(
        WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
        windowType,
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED or
            (if (touch) 0 else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE),
        PixelFormat.TRANSLUCENT
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        title = "LavaTranslate overlay"
        this.alpha = alpha
        windowAnimations = 0
        softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
        layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= 30) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        if (Build.VERSION.SDK_INT >= 30) {
            fitInsetsTypes = 0
            fitInsetsSides = 0
        }
    }

    /** 以透明、不可触摸的状态挂上屏幕，等网页画好 */
    fun attach() {
        LavaApp.instance.webVisible(web, true)
        if (attached) return
        wm.addView(root, params(false))
        attached = true
        visible = false
        touchable = false
    }

    /** 显示出来。touch = false：穿透，看得见但触摸、返回键、焦点都留给下面的应用 */
    fun reveal(touch: Boolean = true) {
        if (!attached) return
        wm.updateViewLayout(root, params(true, 1f, touch))
        visible = true
        touchable = touch
        LavaApp.instance.webVisible(web, true)
        // 拿到焦点，返回手势 / 返回键才会交给这个窗口
        if (touch) root.post { if (!web.requestFocus()) root.requestFocus() }
    }

    fun showKeyboard() {
        if (!visible || !touchable) return
        web.requestFocus()
        if (Build.VERSION.SDK_INT >= 30) root.windowInsetsController?.show(WindowInsets.Type.ime())
        else root.context.getSystemService(android.view.inputmethod.InputMethodManager::class.java).showSoftInput(web, 0)
    }

    /**
     * 收起但不撤掉窗口（无障碍模式的翻译过程中一直挂着，保证小胶囊始终在它上面）：
     * 完全透明、不接触摸、不抢焦点，下面的应用照常操作；网页暂停
     */
    fun conceal(pauseWeb: Boolean = true) {
        if (!attached) return
        wm.updateViewLayout(root, params(false))
        visible = false
        touchable = false
        if (pauseWeb) LavaApp.instance.webVisible(web, false)
    }

    /** 按住「对比」：只改透明度看下面的原文，其余不变 */
    fun peek(on: Boolean) {
        if (!attached || !visible) return
        wm.updateViewLayout(root, params(true, if (on) 0f else 1f, touchable))
    }

    fun detach() {
        if (!attached) return
        wm.removeView(root)
        attached = false
        visible = false
        touchable = false
        // 不在屏幕上时暂停网页，不占 CPU
        LavaApp.instance.webVisible(web, false)
    }

    /** 释放网页（几百 MB 内存）；之后这个对象不能再用 */
    fun destroy() {
        detach()
        LavaApp.instance.webGone(web)
        web.destroy()
    }
}
