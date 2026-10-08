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

/**
 * 毛玻璃小窗：无障碍图层上的一个半透明窗口，背后的内容真的被模糊（Android 12+ 跨窗口模糊）。
 * 只有半透明窗口（windowIsTranslucent）才有背景模糊，所以用透明主题的 Dialog 承载；
 * 系统不支持或关掉了模糊（例如省电模式）时，换成更不透明的深色底。
 * 不抢焦点、只拦自己范围内的触摸，其余照常交给下面的应用；可拖动。
 */
class GlassWindow(
    private val ctx: Context,
    private val content: View,
    private val radiusDp: Float,
    /** 拖动结束（窗口左上角，物理像素） */
    private val onMoved: (x: Int, y: Int) -> Unit,
    /** 窗口外的触摸（只告诉有人碰了屏幕，没有坐标） */
    private val onOutside: (() -> Unit)? = null
) {
    private val density = ctx.resources.displayMetrics.density
    private val wm = ctx.getSystemService(WindowManager::class.java)
    // 窗口外的触摸（ACTION_OUTSIDE）只送到 Dialog 自己，到不了里面的视图
    private val dialog = object : Dialog(ctx, android.R.style.Theme_Translucent_NoTitleBar) {
        override fun onTouchEvent(event: MotionEvent): Boolean {
            if (event.actionMasked == MotionEvent.ACTION_OUTSIDE) {
                onOutside?.invoke()
                return true
            }
            return super.onTouchEvent(event)
        }
    }
    private val bg = GradientDrawable().apply {
        cornerRadius = radiusDp * density
        setStroke((density * 0.8f).roundToInt().coerceAtLeast(1), Color.argb(46, 255, 255, 255))
    }
    private val blurListener = Consumer<Boolean> { applyBlur(it) }

    /** 窗口左上角（物理像素） */
    var winX = 0
        private set
    var winY = 0
        private set
    var showing = false
        private set

    init {
        dialog.setCancelable(false)
        dialog.setContentView(DragFrame(ctx, content))
        dialog.window!!.apply {
            setType(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY)
            setFormat(PixelFormat.TRANSLUCENT)
            addFlags(
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                    (if (onOutside != null) WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH else 0)
            )
            clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setLayout(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
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
        bg.setColor(if (on) Color.argb(120, 24, 19, 17) else Color.argb(236, 26, 21, 19))
        if (Build.VERSION.SDK_INT >= 31) dialog.window!!.setBackgroundBlurRadius(if (on) (28 * density).roundToInt() else 0)
    }

    fun show(x: Int, y: Int) {
        move(x, y)
        if (showing) return
        dialog.show()
        showing = true
        if (Build.VERSION.SDK_INT >= 31) wm.addCrossWindowBlurEnabledListener(ctx.mainExecutor, blurListener)
    }

    fun move(x: Int, y: Int) {
        winX = x
        winY = y
        dialog.window!!.attributes = dialog.window!!.attributes.apply {
            this.x = x
            this.y = y
        }
    }

    fun dismiss() {
        if (!showing) return
        if (Build.VERSION.SDK_INT >= 31) wm.removeCrossWindowBlurEnabledListener(blurListener)
        dialog.dismiss()
        showing = false
    }

    /** 内容的大小（物理像素，量过之后才准） */
    fun measure(): Pair<Int, Int> {
        content.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
        return content.measuredWidth to content.measuredHeight
    }

    /**
     * 外层：超过触摸阈值就拖动整个窗口（从按钮上开始拖也行），否则交给里面的按钮。
     */
    @SuppressLint("ViewConstructor")
    private inner class DragFrame(ctx: Context, child: View) : android.widget.FrameLayout(ctx) {
        private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
        private var downX = 0f
        private var downY = 0f
        private var startX = 0
        private var startY = 0
        private var dragging = false

        init {
            addView(child)
        }

        override fun onInterceptTouchEvent(e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX
                    downY = e.rawY
                    startX = winX
                    startY = winY
                    dragging = false
                }
                MotionEvent.ACTION_MOVE -> if (!dragging && (abs(e.rawX - downX) > slop || abs(e.rawY - downY) > slop)) {
                    dragging = true
                    // 让里面按下的按钮取消
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
                    if (!dragging && (abs(e.rawX - downX) > slop || abs(e.rawY - downY) > slop)) dragging = true
                    if (dragging) move(startX + (e.rawX - downX).roundToInt(), startY + (e.rawY - downY).roundToInt())
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
