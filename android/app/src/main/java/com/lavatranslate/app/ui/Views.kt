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

private fun circle(colors: IntArray?, solid: Int = 0) = GradientDrawable().apply {
    shape = GradientDrawable.OVAL
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
            MotionEvent.ACTION_DOWN -> v.animate().scaleX(0.9f).scaleY(0.9f).setDuration(90).start()
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
 * 悬浮面板：熔岩标记 + 名字，右上角关闭；下面三个大按钮：翻译（熔岩色）、回复、设置。
 */
@SuppressLint("ViewConstructor")
class PanelView(ctx: Context, onTranslate: () -> Unit, onReply: () -> Unit, onSettings: () -> Unit, onClose: () -> Unit) : LinearLayout(ctx) {
    init {
        orientation = VERTICAL
        setPadding(ctx.dp(14f), ctx.dp(10f), ctx.dp(10f), ctx.dp(14f))

        val head = LinearLayout(ctx).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        head.addView(ImageView(ctx).apply {
            setImageResource(R.drawable.ic_mark)
            imageTintList = ColorStateList.valueOf(Color.rgb(255, 110, 44))
        }, LayoutParams(ctx.dp(15f), ctx.dp(15f)).apply { marginStart = ctx.dp(4f) })
        head.addView(TextView(ctx).apply {
            text = "LavaTranslate"
            setTextColor(Color.argb(178, 255, 255, 255))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            letterSpacing = 0.02f
        }, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = ctx.dp(7f) })
        val close = FrameLayout(ctx).apply {
            background = circle(null, Color.argb(30, 255, 255, 255))
            contentDescription = "关闭"
            addView(ImageView(ctx).apply {
                setImageResource(R.drawable.ic_lc_close)
                imageTintList = ColorStateList.valueOf(Color.argb(210, 255, 255, 255))
            }, FrameLayout.LayoutParams(ctx.dp(14f), ctx.dp(14f), Gravity.CENTER))
            pressable(onClose)
        }
        head.addView(close, LayoutParams(ctx.dp(28f), ctx.dp(28f)))
        addView(head, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))

        val row = LinearLayout(ctx).apply { orientation = HORIZONTAL }
        row.addView(action(ctx, "翻译", R.drawable.ic_lc_translate, true, onTranslate))
        row.addView(action(ctx, "回复", R.drawable.ic_lc_reply, false, onReply))
        row.addView(action(ctx, "设置", R.drawable.ic_lc_settings, false, onSettings))
        addView(row, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = ctx.dp(8f) })
    }

    private fun action(ctx: Context, label: String, icon: Int, primary: Boolean, onTap: () -> Unit): View {
        val box = LinearLayout(ctx).apply {
            orientation = VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            contentDescription = label
        }
        val disc = FrameLayout(ctx).apply {
            background = if (primary) circle(LAVA) else circle(null, Color.argb(34, 255, 255, 255))
            if (primary) {
                elevation = ctx.dp(6f).toFloat()
                outlineSpotShadowColor = Color.rgb(255, 90, 31)
                outlineAmbientShadowColor = Color.rgb(255, 90, 31)
            }
            addView(ImageView(ctx).apply { setImageResource(icon) }, FrameLayout.LayoutParams(ctx.dp(24f), ctx.dp(24f), Gravity.CENTER))
        }
        box.addView(disc, LayoutParams(ctx.dp(54f), ctx.dp(54f)))
        box.addView(TextView(ctx).apply {
            text = label
            setTextColor(Color.argb(235, 255, 255, 255))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            gravity = Gravity.CENTER
        }, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { topMargin = ctx.dp(6f) })
        box.layoutParams = LayoutParams(ctx.dp(76f), LayoutParams.WRAP_CONTENT)
        box.pressable(onTap)
        return box
    }
}

/**
 * 翻译时的小胶囊（竖着，贴边）：按住「对比」看原文、松开回到译文；「回复」打开回复；「退出」回到面板。
 * 顶上一个小点：正在翻译时一闪一闪。
 */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class CapsuleView(ctx: Context, onPeek: (Boolean) -> Unit, onReply: () -> Unit, onExit: () -> Unit) : LinearLayout(ctx) {
    private val dot = View(ctx).apply {
        background = circle(LAVA)
        alpha = 0f
    }
    private var pulse: ValueAnimator? = null

    init {
        orientation = VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        setPadding(ctx.dp(4f), ctx.dp(7f), ctx.dp(4f), ctx.dp(5f))
        addView(dot, LayoutParams(ctx.dp(6f), ctx.dp(6f)))

        val compare = button(ctx, R.drawable.ic_lc_compare, "按住对比原文")
        compare.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                    v.background = circle(LAVA)
                    onPeek(true)
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    v.background = null
                    onPeek(false)
                }
            }
            true
        }
        addView(compare, LayoutParams(ctx.dp(40f), ctx.dp(40f)).apply { topMargin = ctx.dp(3f) })
        addView(button(ctx, R.drawable.ic_lc_reply, "回复").apply { pressable(onReply) }, LayoutParams(ctx.dp(40f), ctx.dp(40f)).apply { topMargin = ctx.dp(2f) })
        addView(button(ctx, R.drawable.ic_lc_close, "退出").apply { pressable(onExit) }, LayoutParams(ctx.dp(40f), ctx.dp(40f)).apply { topMargin = ctx.dp(2f) })
    }

    private fun button(ctx: Context, icon: Int, label: String) = FrameLayout(ctx).apply {
        contentDescription = label
        addView(ImageView(ctx).apply {
            setImageResource(icon)
            imageTintList = ColorStateList.valueOf(Color.argb(235, 255, 255, 255))
        }, FrameLayout.LayoutParams(ctx.dp(20f), ctx.dp(20f), Gravity.CENTER))
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
