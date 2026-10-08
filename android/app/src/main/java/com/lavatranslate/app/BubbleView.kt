package com.lavatranslate.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewOutlineProvider
import android.view.WindowManager
import androidx.dynamicanimation.animation.FloatValueHolder
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce
import com.lavatranslate.app.capture.Screen
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * 悬浮球（原生）：贴边、可拖动；单击翻译屏幕，长按打开菜单（快捷回复、译成、设置、退出）。
 * 翻译界面打开时它藏起来，由网页里一模一样的球接替（位置同步），关闭后再出现。
 * 画法与应用图标一致：深色玻璃球里一滴从朱红到琥珀的发光熔岩，里面两行文字。
 */
@SuppressLint("ViewConstructor")
class BubbleView(
    ctx: Context,
    private val wm: WindowManager,
    windowType: Int,
    private val onTap: () -> Unit,
    private val onLongPress: () -> Unit,
    private val onMoved: (side: String, yFraction: Double) -> Unit
) : View(ctx) {
    private val density = resources.displayMetrics.density
    val orb = (ORB_DP * density).roundToInt()
    private val pad = (PAD_DP * density).roundToInt() // 留给阴影
    private val margin = (MARGIN_DP * density).roundToInt()

    val params = WindowManager.LayoutParams(
        orb + pad * 2, orb + pad * 2,
        windowType,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        title = "LavaTranslate bubble"
        // 坐标按整块屏幕算（默认会从状态栏下面算起，和翻译界面里那个球对不齐）
        flags = flags or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            fitInsetsTypes = 0
            fitInsetsSides = 0
        }
        layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }

    /** 截屏授权已失效（下次点击会先弹系统授权） */
    var needsConsent = false
        set(v) {
            field = v
            invalidate()
        }

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = density
        color = Color.argb(46, 255, 255, 255)
    }
    private val lava = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shade = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shine = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(242, 255, 255, 255) }
    private val badge = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(255, 214, 10) }
    private val badgeRim = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2 * density
        color = Color.rgb(13, 11, 10)
    }
    private val drop = Path()
    private val lines = ArrayList<RectF>()

    init {
        val o = pad.toFloat()
        val c = o + orb / 2f
        val r = orb / 2f
        // 深色玻璃球，里面一滴发光的熔岩（与应用图标同一画法：scripts/icons/lava.py）
        fill.shader = RadialGradient(c, c - r * 0.45f, r * 1.35f, Color.rgb(48, 40, 37), Color.rgb(13, 11, 10), Shader.TileMode.CLAMP)
        glow.shader = RadialGradient(c, c + r * 0.3f, r * 0.85f, Color.argb(110, 255, 138, 0), Color.TRANSPARENT, Shader.TileMode.CLAMP)
        // 熔岩滴：图标 1024 视口里底部圆心 (512, 616)、半径 236，尖端在圆心上方 470；整体竖向中心 499
        val k = orb * 0.6f / 706f
        val ox = c - 512f * k
        val oy = c - 499f * k
        val cx = ox + 512f * k
        val cy = oy + 616f * k
        val dr = 236f * k
        val tip = 470f * k
        val beta = Math.toDegrees(Math.acos((dr / tip).toDouble())).toFloat()
        val start = 180f + (90f - beta) // 左侧切点（屏幕坐标，顺时针为正）
        drop.apply {
            moveTo(cx, cy - tip)
            val a = Math.toRadians(start.toDouble())
            lineTo(cx + dr * Math.cos(a).toFloat(), cy + dr * Math.sin(a).toFloat())
            arcTo(cx - dr, cy - dr, cx + dr, cy + dr, start, -(360f - 2 * (90f - beta)) , false)
            close()
        }
        val top = cy - tip
        val bottom = cy + dr
        lava.shader = LinearGradient(0f, top, 0f, bottom, intArrayOf(Color.rgb(255, 45, 45), Color.rgb(255, 90, 31), Color.rgb(255, 182, 39)), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
        shade.shader = RadialGradient(cx - dr + 2 * dr * 0.7f, top + (bottom - top) * 0.85f, (bottom - top) * 0.6f, intArrayOf(Color.TRANSPARENT, Color.TRANSPARENT, Color.argb(90, 122, 20, 0)), floatArrayOf(0f, 0.4f, 1f), Shader.TileMode.CLAMP)
        shine.shader = RadialGradient(cx - dr + 2 * dr * 0.36f, top + (bottom - top) * 0.42f, 2 * dr * 0.32f, Color.argb(140, 255, 255, 255), Color.TRANSPARENT, Shader.TileMode.CLAMP)
        for ((x, y, w) in listOf(Triple(392f, 600f, 240f), Triple(392f, 684f, 160f))) lines.add(RectF(ox + x * k, oy + y * k, ox + (x + w) * k, oy + (y + 50f) * k))
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) = outline.setOval(pad, pad, pad + orb, pad + orb)
        }
        elevation = 7 * density
        alpha = 0f
    }

    override fun onDraw(canvas: Canvas) {
        val c = pad + orb / 2f
        val r = orb / 2f
        canvas.drawCircle(c, c, r, fill)
        canvas.drawCircle(c, c, r, glow)
        canvas.drawCircle(c, c, r - density / 2, rim)
        canvas.drawPath(drop, lava)
        canvas.drawPath(drop, shade)
        canvas.drawPath(drop, shine)
        for (l in lines) canvas.drawRoundRect(l, l.height() / 2, l.height() / 2, text)
        if (needsConsent) {
            val bx = pad + orb - orb * 0.16f
            val by = pad + orb * 0.16f
            canvas.drawCircle(bx, by, orb * 0.12f, badge)
            canvas.drawCircle(bx, by, orb * 0.12f, badgeRim)
        }
    }

    // ------------------------------------------------------------ 位置
    private var side = "right"
    private var yFraction = 0.38

    fun place(side: String, yFraction: Double) {
        this.side = side
        this.yFraction = yFraction
        val size = Screen.size(context)
        params.x = edgeX(side, size.x)
        params.y = clampY((yFraction * size.y).roundToInt() - pad, size.y)
        if (isAttachedToWindow) wm.updateViewLayout(this, params)
    }

    private fun edgeX(side: String, screenW: Int) = edgeX(side, screenW, orb, pad, margin)

    private fun clampY(y: Int, screenH: Int) = clampY(context, y, screenH, orb, pad, margin)

    /** 球在屏幕上的位置（物理像素） */
    fun orbRect() = android.graphics.Rect(params.x + pad, params.y + pad, params.x + pad + orb, params.y + pad + orb)

    // ------------------------------------------------------------ 显示
    fun show() {
        animate().cancel()
        visibility = VISIBLE
        animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(220).start()
        scheduleRest()
    }

    /** 截屏前立刻藏起（不能有淡出动画，否则会被截进去） */
    fun hideNow() {
        animate().cancel()
        removeCallbacks(rest)
        alpha = 0f
        visibility = INVISIBLE
    }

    /** 一段时间不碰就变淡，不挡内容 */
    private val rest = Runnable { animate().alpha(0.62f).setDuration(600).start() }

    private fun scheduleRest() {
        removeCallbacks(rest)
        postDelayed(rest, 3200)
    }

    // ------------------------------------------------------------ 触摸
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var startX = 0
    private var startY = 0
    private var dragging = false
    private var longFired = false
    private var snap: SpringAnimation? = null

    private val longPress = Runnable {
        longFired = true
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        press(false)
        onLongPress()
    }

    private fun press(on: Boolean) {
        animate().scaleX(if (on) 0.9f else 1f).scaleY(if (on) 0.9f else 1f).alpha(1f).setDuration(if (on) 90 else 180).start()
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                snap?.cancel()
                downX = e.rawX
                downY = e.rawY
                startX = params.x
                startY = params.y
                dragging = false
                longFired = false
                removeCallbacks(rest)
                press(true)
                postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = e.rawX - downX
                val dy = e.rawY - downY
                if (!dragging && !longFired && hypot(dx, dy) > slop) {
                    dragging = true
                    removeCallbacks(longPress)
                    press(false)
                }
                if (dragging) {
                    params.x = (startX + dx).roundToInt()
                    params.y = clampY((startY + dy).roundToInt(), Screen.size(context).y)
                    wm.updateViewLayout(this, params)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                removeCallbacks(longPress)
                if (!longFired) press(false)
                if (dragging) settle()
                else if (!longFired && e.actionMasked == MotionEvent.ACTION_UP) {
                    performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                    onTap()
                }
                scheduleRest()
            }
        }
        return true
    }

    /** 松手后弹回最近的一侧边缘 */
    private fun settle() {
        val size = Screen.size(context)
        val center = params.x + pad + orb / 2
        side = if (center < size.x / 2) "left" else "right"
        val target = edgeX(side, size.x).toFloat()
        yFraction = (params.y + pad).toDouble() / size.y
        onMoved(side, yFraction)
        snap = SpringAnimation(FloatValueHolder(params.x.toFloat())).apply {
            spring = SpringForce(target).setStiffness(520f).setDampingRatio(0.72f)
            addUpdateListener { _, v, _ ->
                params.x = v.roundToInt()
                if (isAttachedToWindow) wm.updateViewLayout(this@BubbleView, params)
            }
            start()
        }
    }

    companion object {
        private const val ORB_DP = 52
        private const val PAD_DP = 14
        private const val MARGIN_DP = 6

        private fun edgeX(side: String, screenW: Int, orb: Int, pad: Int, margin: Int) = if (side == "left") margin - pad else screenW - margin - orb - pad

        private fun clampY(ctx: Context, y: Int, screenH: Int, orb: Int, pad: Int, margin: Int): Int {
            val top = Screen.content(ctx, Screen.size(ctx).x, screenH).top
            return y.coerceIn(top + margin - pad, screenH - Screen.navBottom(ctx) - orb - margin - pad)
        }

        /** 悬浮球没显示时（用无障碍按钮、快捷开关打开），翻译界面里的球放在它平时停靠的位置 */
        fun restingRect(ctx: Context, side: String, yFraction: Double): android.graphics.Rect {
            val d = ctx.resources.displayMetrics.density
            val orb = (ORB_DP * d).roundToInt()
            val pad = (PAD_DP * d).roundToInt()
            val margin = (MARGIN_DP * d).roundToInt()
            val size = Screen.size(ctx)
            val x = edgeX(side, size.x, orb, pad, margin) + pad
            val y = clampY(ctx, (yFraction * size.y).roundToInt() - pad, size.y, orb, pad, margin) + pad
            return android.graphics.Rect(x, y, x + orb, y + orb)
        }
    }
}
