package com.lavatranslate.app

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings

/**
 * 透明的中转页：
 * - 弹出系统截屏授权框（只有 Activity 能弹），结果交给悬浮服务；
 * - 从通知栏、快捷开关点「翻译屏幕」时经由这里，系统会先收起通知栏，再开始截屏。
 */
class ConsentActivity : Activity() {
    private var thenTranslate = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        thenTranslate = intent.getBooleanExtra(EXTRA_TRANSLATE, false)
        if (!Settings.canDrawOverlays(this)) {
            startActivity(Intent(this, MainActivity::class.java))
            return finish()
        }
        val svc = FloatService.instance
        val needsConsent = svc?.needsConsent ?: (LavaApp.instance.settings.str("captureMode") != "accessibility")
        if (thenTranslate && !needsConsent) {
            if (svc == null) FloatService.start(this, FloatService.ACTION_TRANSLATE, 500) else svc.translateLater(500)
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
        private const val REQ = 7
    }
}
