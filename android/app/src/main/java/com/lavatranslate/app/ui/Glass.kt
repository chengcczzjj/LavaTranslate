package com.lavatranslate.app.ui

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.WindowManager
import java.util.function.Consumer
import kotlin.math.abs
import kotlin.math.roundToInt

/** 无障碍图层上的小窗：显示、移动、拖动（松手时回调） */
abstract class OverlayWindow(protected val ctx: Context, protected val content: View, private val width: Int?) {
    /** 窗口以外的地方被按下（只有设了 FLAG_WATCH_OUTSIDE_TOUCH 的窗口会收到） */
    var onOutside: (() -> Unit)? = null

    protected val wm: WindowManager = ctx.getSystemService(WindowManager::class.java)

    /** 窗口左上角（物理像素） */
    var winX = 0
        protected set
    var winY = 0
        protected set
    var showing = false
        protected set

    abstract fun show(x: Int, y: Int)
    abstract fun move(x: Int, y: Int)
    abstract fun dismiss()

    /** 内容的大小（物理像素） */
    fun measure(): Pair<Int, Int> {
        val ws = if (width != null) View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY) else View.MeasureSpec.UNSPECIFIED
        content.measure(ws, View.MeasureSpec.UNSPECIFIED)
        return content.measuredWidth to content.measuredHeight
    }

    /**
     * 外层：超过触摸阈值就拖动整个窗口（从按钮上开始拖也行），否则交给里面的按钮。
     * horizontal = false 时只上下拖
     */
    @SuppressLint("ViewConstructor")
    protected inner class DragFrame(ctx: Context, child: View, private val horizontal: Boolean, private val onMoved: (Int, Int) -> Unit) : android.widget.FrameLayout(ctx) {
        private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
        private var downX = 0f
        private var downY = 0f
        private var startX = 0
        private var startY = 0
        private var dragging = false

        init {
            addView(child, LayoutParams(if (width != null) LayoutParams.MATCH_PARENT else LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        }

        override fun dispatchTouchEvent(e: MotionEvent): Boolean {
            // 别的窗口被按下（FLAG_WATCH_OUTSIDE_TOUCH，只有按下那一下，坐标是 0）
            if (e.actionMasked == MotionEvent.ACTION_OUTSIDE) {
                onOutside?.invoke()
                return true
            }
            return super.dispatchTouchEvent(e)
        }

        private fun beyond(e: MotionEvent) = (horizontal && abs(e.rawX - downX) > slop) || abs(e.rawY - downY) > slop

        override fun onInterceptTouchEvent(e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX
                    downY = e.rawY
                    startX = winX
                    startY = winY
                    dragging = false
                }
                // 让里面按下的按钮取消
                MotionEvent.ACTION_MOVE -> if (!dragging && beyond(e)) {
                    dragging = true
                    return true
                }
            }
            return dragging
        }

        @SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX
                    downY = e.rawY
                    startX = winX
                    startY = winY
                }
                MotionEvent.ACTION_MOVE -> {
                    if (!dragging && beyond(e)) dragging = true
                    if (dragging) move(if (horizontal) startX + (e.rawX - downX).roundToInt() else startX, startY + (e.rawY - downY).roundToInt())
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (dragging) onMoved(winX, winY)
                    dragging = false
                }
            }
            return true
        }
    }
}

/**
 * 毛玻璃小窗：背后的内容真的被模糊（Android 12+ 跨窗口模糊）。
 * 只有半透明窗口（windowIsTranslucent）才有背景模糊，所以用透明主题的 Dialog 承载；
 * 系统不支持或关掉了模糊（例如省电模式）时，换成更不透明的深色底。
 * 不抢焦点、只拦自己范围内的触摸，其余照常交给下面的应用。
 */
class GlassWindow(
    ctx: Context,
    content: View,
    private val radiusDp: Float,
    /** 固定宽度（物理像素）；null 表示按内容 */
    width: Int?,
    horizontalDrag: Boolean,
    /** 拖动结束（窗口左上角，物理像素） */
    onMoved: (x: Int, y: Int) -> Unit
) : OverlayWindow(ctx, content, width) {
    private val density = ctx.resources.displayMetrics.density
    private val dialog = Dialog(ctx, android.R.style.Theme_Translucent_NoTitleBar)
    private val bg = GradientDrawable().apply {
        cornerRadius = radiusDp * density
        setStroke((density * 0.8f).roundToInt().coerceAtLeast(1), Color.argb(46, 255, 255, 255))
    }
    private val blurListener = Consumer<Boolean> { applyBlur(it) }

    init {
        dialog.setCancelable(false)
        dialog.setContentView(DragFrame(ctx, content, horizontalDrag, onMoved))
        dialog.window!!.apply {
            setType(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY)
            setFormat(PixelFormat.TRANSLUCENT)
            addFlags(
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
            )
            clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setLayout(width ?: ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            setGravity(Gravity.TOP or Gravity.START)
            setWindowAnimations(0)
            setBackgroundDrawable(bg)
            attributes = attributes.apply {
                title = "LavaTranslate glass"
                if (Build.VERSION.SDK_INT >= 30) {
                    fitInsetsTypes = 0
                    fitInsetsSides = 0
                }
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        applyBlur(if (Build.VERSION.SDK_INT >= 31) wm.isCrossWindowBlurEnabled else false)
    }

    private fun applyBlur(on: Boolean) {
        // 有模糊：淡淡的深色玻璃；没有：几乎不透明的深色，保证文字看得清
        bg.setColor(if (on) Color.argb(128, 24, 19, 17) else Color.argb(238, 26, 21, 19))
        if (Build.VERSION.SDK_INT >= 31) dialog.window!!.setBackgroundBlurRadius(if (on) (28 * density).roundToInt() else 0)
    }

    override fun show(x: Int, y: Int) {
        move(x, y)
        if (showing) return
        dialog.show()
        showing = true
        if (Build.VERSION.SDK_INT >= 31) wm.addCrossWindowBlurEnabledListener(ctx.mainExecutor, blurListener)
    }

    override fun move(x: Int, y: Int) {
        winX = x
        winY = y
        dialog.window!!.attributes = dialog.window!!.attributes.apply {
            this.x = x
            this.y = y
        }
    }

    override fun dismiss() {
        if (!showing) return
        if (Build.VERSION.SDK_INT >= 31) wm.removeCrossWindowBlurEnabledListener(blurListener)
        dialog.dismiss()
        showing = false
    }
}

/** 普通的小窗（不模糊，深色底由内容自己画）：翻译时的小胶囊用它，各家系统上显示都一致 */
class PlainWindow(ctx: Context, content: View, onMoved: (x: Int, y: Int) -> Unit) : OverlayWindow(ctx, content, null) {
    private val frame = DragFrame(ctx, content, true, onMoved)
    private val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED or
            WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
        PixelFormat.TRANSLUCENT
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        title = "LavaTranslate capsule"
        windowAnimations = 0
        if (Build.VERSION.SDK_INT >= 30) {
            fitInsetsTypes = 0
            fitInsetsSides = 0
        }
        layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }

    override fun show(x: Int, y: Int) {
        winX = x
        winY = y
        params.x = x
        params.y = y
        if (showing) return wm.updateViewLayout(frame, params)
        wm.addView(frame, params)
        showing = true
    }

    override fun move(x: Int, y: Int) {
        winX = x
        winY = y
        params.x = x
        params.y = y
        if (showing) wm.updateViewLayout(frame, params)
    }

    override fun dismiss() {
        if (!showing) return
        wm.removeView(frame)
        showing = false
    }
}
