package com.lavatranslate.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.lavatranslate.app.capture.LavaAccessibilityService

/**
 * 点 LavaTranslate 图标：无障碍模式已就绪就直接弹出悬浮面板（不打开任何页面，面板浮在当前桌面上）；
 * 否则打开设置页（首次使用的引导、截屏授权模式）。没有界面，一出现就结束。
 * 桌面图标指向的组件名仍是 .MainActivity（manifest 里的别名），已经放在桌面上的图标继续有效。
 */
class LaunchActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val host = LavaAccessibilityService.instance?.host
        if (LavaAccessibilityService.mode && host != null) host.showPanel()
        else startActivity(Intent(this, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }
}
