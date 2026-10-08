package com.lavatranslate.app.ui

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.lavatranslate.app.R
import kotlin.math.roundToInt

private fun Context.dp(v: Float) = (v * resources.displayMetrics.density).roundToInt()

/** 熔岩色渐变（与图标一致） */
private val LAVA = intArrayOf(Color.rgb(255, 61, 45), Color.rgb(255, 90, 31), Color.rgb(255, 170, 39))

private fun shape(radius: Float, colors: IntArray? = null, solid: Int = 0, oval: Boolean = false) = GradientDrawable().apply {
    if (oval) shape = GradientDrawable.OVAL else cornerRadius = radius
    if (colors != null) {
        this.colors = colors
        orientation = GradientDrawable.Orientation.TL_BR
    } else setColor(solid)
}

/** 按下缩一点，松开弹回 */
@SuppressLint("ClickableViewAccessibility")
private fun View.pressable(onTap: () -> Unit) {
    setOnTouchListener { v, e ->
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> v.animate().scaleX(0.92f).scaleY(0.92f).setDuration(90).start()
            MotionEvent.ACTION_UP -> {
                v.animate().scaleX(1f).scaleY(1f).setDuration(180).start()
                if (e.x in 0f..v.width.toFloat() && e.y in 0f..v.height.toFloat()) {
                    v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                    onTap()
                }
            }
            MotionEvent.ACTION_CANCEL -> v.animate().scaleX(1f).scaleY(1f).setDuration(180).start()
        }
        true
    }
}

/**
 * 悬浮面板：屏幕上方一条宽而矮的毛玻璃横条（像从上面弹下来的通知，高约 34dp）：
 * 熔岩标记、翻译（熔岩色）、回复、设置，最右边关闭。
 */
@SuppressLint("ViewConstructor")
class PanelBar(ctx: Context, onTranslate: () -> Unit, onReply: () -> Unit, onSettings: () -> Unit, onClose: () -> Unit) : LinearLayout(ctx) {
    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(ctx.dp(10f), ctx.dp(3f), ctx.dp(3f), ctx.dp(3f))
        addView(ImageView(ctx).apply {
            setImageResource(R.drawable.ic_mark)
            imageTintList = ColorStateList.valueOf(Color.rgb(255, 110, 44))
        }, LayoutParams(ctx.dp(14f), ctx.dp(14f)).apply { marginEnd = ctx.dp(8f) })
        addView(pill(ctx, "翻译", R.drawable.ic_lc_translate, true, onTranslate))
        addView(pill(ctx, "回复", R.drawable.ic_lc_reply, false, onReply))
        addView(pill(ctx, "设置", R.drawable.ic_lc_settings, false, onSettings))
        addView(View(ctx), LayoutParams(0, 0, 1f))
        addView(FrameLayout(ctx).apply {
            background = shape(0f, solid = Color.argb(30, 255, 255, 255), oval = true)
            contentDescription = "关闭"
            addView(ImageView(ctx).apply {
                setImageResource(R.drawable.ic_lc_close)
                imageTintList = ColorStateList.valueOf(Color.argb(215, 255, 255, 255))
            }, FrameLayout.LayoutParams(ctx.dp(12f), ctx.dp(12f), Gravity.CENTER))
            pressable(onClose)
        }, LayoutParams(ctx.dp(28f), ctx.dp(28f)))
    }

    private fun pill(ctx: Context, label: String, icon: Int, primary: Boolean, onTap: () -> Unit): View {
        val row = LinearLayout(ctx).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER
            contentDescription = label
            background = if (primary) shape(ctx.dp(14f).toFloat(), LAVA) else shape(ctx.dp(14f).toFloat(), solid = Color.argb(34, 255, 255, 255))
            setPadding(ctx.dp(10f), 0, ctx.dp(12f), 0)
        }
        row.addView(ImageView(ctx).apply { setImageResource(icon) }, LayoutParams(ctx.dp(14f), ctx.dp(14f)))
        row.addView(TextView(ctx).apply {
            text = label
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            typeface = Typeface.create(Typeface.DEFAULT, if (primary) Typeface.BOLD else Typeface.NORMAL)
            includeFontPadding = false
        }, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = ctx.dp(5f) })
        row.layoutParams = LayoutParams(LayoutParams.WRAP_CONTENT, ctx.dp(28f)).apply { marginEnd = ctx.dp(6f) }
        row.pressable(onTap)
        return row
    }
}

/**
 * 翻译时贴边的小胶囊（竖着，深色）：
 * - 译文显示时：按住「对比」看原文、松开回到译文；
 * - 译文让开后（应用在滚动）：第一个按钮变成「翻译」，点一下马上重新翻译（停下后也会自动翻译）；
 * - 「回复」打开回复；「退出」回到面板。
 * 顶上一个小点：正在翻译时一闪一闪。
 */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class CapsuleView(ctx: Context, onCompare: (Boolean) -> Unit, onTranslate: () -> Unit, onReply: () -> Unit, onExit: () -> Unit) : LinearLayout(ctx) {
    private val dot = View(ctx).apply {
        background = shape(0f, LAVA, oval = true)
        alpha = 0f
    }
    private var pulse: ValueAnimator? = null
    private val first: FrameLayout
    private val firstIcon: ImageView
    private var waiting = false

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        background = shape(ctx.dp(18f).toFloat(), solid = Color.argb(232, 26, 21, 19)).apply {
            setStroke(ctx.dp(1f), Color.argb(40, 255, 255, 255))
        }
        setPadding(ctx.dp(3f), ctx.dp(4f), ctx.dp(3f), ctx.dp(3f))
        addView(dot, LayoutParams(ctx.dp(4f), ctx.dp(4f)))

        firstIcon = ImageView(ctx).apply {
            setImageResource(R.drawable.ic_lc_compare)
            imageTintList = ColorStateList.valueOf(Color.argb(240, 255, 255, 255))
        }
        first = FrameLayout(ctx).apply {
            contentDescription = "按住对比原文"
            addView(firstIcon, FrameLayout.LayoutParams(ctx.dp(17f), ctx.dp(17f), Gravity.CENTER))
        }
        first.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                    if (waiting) v.animate().scaleX(0.9f).scaleY(0.9f).setDuration(90).start()
                    else {
                        v.background = shape(0f, LAVA, oval = true)
                        onCompare(true)
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (waiting) {
                        v.animate().scaleX(1f).scaleY(1f).setDuration(180).start()
                        if (e.actionMasked == MotionEvent.ACTION_UP) onTranslate()
                    } else {
                        v.background = null
                        onCompare(false)
                    }
                }
            }
            true
        }
        addView(first, LayoutParams(ctx.dp(32f), ctx.dp(32f)).apply { topMargin = ctx.dp(2f) })
        addView(button(ctx, R.drawable.ic_lc_reply, "回复").apply { pressable(onReply) }, LayoutParams(ctx.dp(32f), ctx.dp(32f)))
        addView(button(ctx, R.drawable.ic_lc_close, "退出").apply { pressable(onExit) }, LayoutParams(ctx.dp(32f), ctx.dp(32f)))
    }

    private fun button(ctx: Context, icon: Int, label: String) = FrameLayout(ctx).apply {
        contentDescription = label
        addView(ImageView(ctx).apply {
            setImageResource(icon)
            imageTintList = ColorStateList.valueOf(Color.argb(240, 255, 255, 255))
        }, FrameLayout.LayoutParams(ctx.dp(17f), ctx.dp(17f), Gravity.CENTER))
    }

    /** 译文让开了、等着重新翻译：第一个按钮变成熔岩色的「翻译」 */
    fun waiting(on: Boolean) {
        if (waiting == on) return
        waiting = on
        first.background = if (on) shape(0f, LAVA, oval = true) else null
        firstIcon.setImageResource(if (on) R.drawable.ic_lc_translate else R.drawable.ic_lc_compare)
        first.contentDescription = if (on) "翻译" else "按住对比原文"
    }

    /** 正在识别、翻译：小点呼吸；完成后淡出（不用时没有任何动画，不耗电） */
    fun busy(on: Boolean) {
        pulse?.cancel()
        pulse = null
        if (!on) {
            dot.animate().alpha(0f).setDuration(300).start()
            return
        }
        dot.animate().cancel()
        pulse = ValueAnimator.ofFloat(0.25f, 1f).apply {
            duration = 650
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener { dot.alpha = it.animatedValue as Float }
            start()
        }
    }
}
