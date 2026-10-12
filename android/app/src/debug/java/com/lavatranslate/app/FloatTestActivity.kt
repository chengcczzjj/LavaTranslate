package com.lavatranslate.app

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.WindowManager
import android.widget.TextView

/**
 * 调试用：模拟别的应用的小悬浮窗（例如录屏控制条），每次启动切换显示 / 隐藏。
 * 先 adb shell appops set com.lavatranslate.app SYSTEM_ALERT_WINDOW allow，
 * 再 adb shell am start -n com.lavatranslate.app/.FloatTestActivity
 */
class FloatTestActivity : Activity() {
    @SuppressLint("SetTextI18n")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val wm = applicationContext.getSystemService(WindowManager::class.java)
        val old = view
        if (old != null) {
            wm.removeView(old)
            view = null
        } else {
            val v = TextView(applicationContext).apply {
                setBackgroundColor(Color.rgb(220, 40, 40))
                setTextColor(Color.WHITE)
                textSize = 16f
                setPadding(32, 20, 32, 20)
            }
            val start = System.currentTimeMillis()
            val tick = object : Runnable {
                override fun run() {
                    if (view !== v) return
                    v.text = "● REC %02d".format((System.currentTimeMillis() - start) / 1000)
                    main.postDelayed(this, 1000)
                }
            }
            wm.addView(v, WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT
            ).apply {
                gravity = Gravity.TOP or Gravity.START
                x = 40
                y = 700
                title = "Recorder test"
            })
            view = v
            tick.run()
        }
        finish()
    }

    companion object {
        private val main = Handler(Looper.getMainLooper())
        private var view: TextView? = null
    }
}
