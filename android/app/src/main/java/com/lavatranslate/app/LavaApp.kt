package com.lavatranslate.app

import android.app.Application
import android.webkit.WebView
import com.lavatranslate.app.ocr.PaddleOcr
import com.lavatranslate.app.web.NetBridge
import java.util.concurrent.Executors

class LavaApp : Application() {
    val settings by lazy { SettingsStore(this) }
    val ocr by lazy { PaddleOcr(this) }
    val net by lazy { NetBridge() }

    /** OCR、编码图片等耗时工作 */
    val worker = Executors.newFixedThreadPool(2)

    override fun onCreate() {
        super.onCreate()
        instance = this
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
    }

    companion object {
        lateinit var instance: LavaApp
            private set
    }
}
