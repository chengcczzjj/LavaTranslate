package com.lavatranslate.app

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import com.lavatranslate.app.capture.LavaAccessibilityService

/**
 * 透明的中转页：
 * - 弹出系统截屏授权框（只有 Activity 能弹），结果交给悬浮服务；
 * - 从通知栏、快捷开关点「翻译屏幕」「快捷回复」时经由这里，系统会先收起通知栏，再开始截屏
 *   （无障碍模式在 Android 12 起不经过这里，由服务自己收起通知栏）。
 */
class ConsentActivity : Activity() {
    private var thenTranslate = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        thenTranslate = intent.getBooleanExtra(EXTRA_TRANSLATE, false)
        val quick = intent.getBooleanExtra(EXTRA_QUICK, false)
        // 无障碍模式：交给无障碍服务（它不需要悬浮窗权限和截屏授权）
        val a11y = LavaAccessibilityService.instance
        if (a11y != null && (thenTranslate || quick)) {
            a11y.later(quick, 500)
            return finish()
        }
        if (LavaAccessibilityService.mode && (thenTranslate || quick) || !Settings.canDrawOverlays(this)) {
            // 选了无障碍模式但还没开启、或没有悬浮窗权限：去设置页
            startActivity(Intent(this, MainActivity::class.java))
            return finish()
        }
        val svc = FloatService.instance
        if (quick) {
            if (svc == null) FloatService.start(this, FloatService.ACTION_QUICK, 500) else svc.quickLater(500)
            return finish()
        }
        if (thenTranslate && svc?.needsConsent == false) {
            svc.translateLater(500)
            return finish()
        }
        if (svc == null) FloatService.start(this)
        if (savedInstanceState != null) return
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val i = if (Build.VERSION.SDK_INT >= 34) mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        else mpm.createScreenCaptureIntent()
        @Suppress("DEPRECATION")
        startActivityForResult(i, REQ)
    }

    @Deprecated("startActivityForResult")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ) FloatService.instance?.onConsent(resultCode, data, thenTranslate)
        finish()
    }

    override fun finish() {
        super.finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    companion object {
        const val EXTRA_TRANSLATE = "translate"
        const val EXTRA_QUICK = "quick"
        private const val REQ = 7
    }
}
