package com.lavatranslate.app.capture

import android.content.Context
import android.graphics.Point
import android.graphics.Rect
import android.os.Build
import android.view.WindowInsets
import android.view.WindowManager

/** 屏幕几何：完整尺寸（含状态栏、导航条）与系统栏占用 */
object Screen {
    fun size(ctx: Context): Point {
        val wm = ctx.getSystemService(WindowManager::class.java)
        if (Build.VERSION.SDK_INT >= 30) {
            val b = wm.maximumWindowMetrics.bounds
            return Point(b.width(), b.height())
        }
        @Suppress("DEPRECATION")
        return Point().also { wm.defaultDisplay.getRealSize(it) }
    }

    /**
     * 要翻译的区域：去掉顶部状态栏（时间、电量，含刘海）。
     * 底部导航条不去掉：Android 15 起应用都画到导航条下面（输入框、底栏常在那里），手势条本身没有文字
     */
    fun content(ctx: Context, w: Int, h: Int): Rect {
        var top = if (Build.VERSION.SDK_INT >= 30) {
            val wm = ctx.getSystemService(WindowManager::class.java)
            wm.maximumWindowMetrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.statusBars() or WindowInsets.Type.displayCutout()).top
        } else dimen(ctx, "status_bar_height")
        // 异常值（横屏等）就退回整屏
        if (top > h / 6) top = 0
        return Rect(0, top, w, h)
    }

    /** 底部导航条高度（悬浮球不要停在那里） */
    fun navBottom(ctx: Context): Int = if (Build.VERSION.SDK_INT >= 30) {
        ctx.getSystemService(WindowManager::class.java).maximumWindowMetrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.navigationBars()).bottom
    } else dimen(ctx, "navigation_bar_height")

    @Suppress("DiscouragedApi", "InternalInsetResource")
    private fun dimen(ctx: Context, name: String): Int {
        val id = ctx.resources.getIdentifier(name, "dimen", "android")
        return if (id > 0) ctx.resources.getDimensionPixelSize(id) else 0
    }
}
