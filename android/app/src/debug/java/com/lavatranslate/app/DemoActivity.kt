package com.lavatranslate.app

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient

/** 调试用：adb shell am start -n com.lavatranslate.app/.DemoActivity -d <网址> */
class DemoActivity : Activity() {
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.webViewClient = WebViewClient()
        setContentView(web)
        web.loadUrl(intent.dataString ?: "http://127.0.0.1:8789/chat.html")
    }
}
