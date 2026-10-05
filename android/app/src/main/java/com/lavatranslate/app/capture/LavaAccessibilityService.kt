package com.lavatranslate.app.capture

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.provider.Settings
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 免授权截屏：用户在「无障碍」里打开一次后一直有效（Android 11+ 的 takeScreenshot）。
 * 只用来在用户点悬浮球时截一次屏，不读取界面内容、不执行操作（见 res/xml/accessibility_service.xml）。
 */
class LavaAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        instance = this
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    companion object {
        @Volatile
        var instance: LavaAccessibilityService? = null
            private set

        val supported get() = Build.VERSION.SDK_INT >= 30

        /** 系统设置里是否已打开（服务可能还没连上） */
        fun enabled(ctx: Context): Boolean {
            val list = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            val me = ComponentName(ctx, LavaAccessibilityService::class.java)
            return list.split(':').any { ComponentName.unflattenFromString(it) == me }
        }
    }
}

class A11yCapturer(private val ctx: Context) : ScreenCapturer {
    private val executor = Executors.newSingleThreadExecutor()

    override fun capture(): Frame {
        if (Build.VERSION.SDK_INT < 30) throw CaptureException("免授权截屏需要 Android 11 或更高版本")
        val svc = LavaAccessibilityService.instance ?: throw CaptureException("免授权截屏未开启：请在系统「无障碍」里打开 LavaTranslate")
        val latch = CountDownLatch(1)
        var frame: Frame? = null
        var error: String? = null
        svc.takeScreenshot(Display.DEFAULT_DISPLAY, executor, object : AccessibilityService.TakeScreenshotCallback {
            override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                try {
                    val hb = result.hardwareBuffer
                    val bmp = Bitmap.wrapHardwareBuffer(hb, result.colorSpace)?.copy(Bitmap.Config.ARGB_8888, false)
                    hb.close()
                    if (bmp == null) error = "截屏失败"
                    else {
                        // ARGB_8888 在内存里按 R G B A 排列
                        val buf = ByteBuffer.allocate(bmp.byteCount)
                        bmp.copyPixelsToBuffer(buf)
                        val w = bmp.width
                        val h = bmp.height
                        bmp.recycle()
                        frame = Frame(ProjectionCapturer.seq.incrementAndGet(), w, h, buf.array(), Screen.content(ctx, w, h), ctx.resources.displayMetrics.density)
                    }
                } catch (e: Exception) {
                    error = e.message ?: "截屏失败"
                }
                latch.countDown()
            }

            override fun onFailure(errorCode: Int) {
                error = when (errorCode) {
                    AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "截屏太频繁，稍等再试"
                    AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW -> "当前页面禁止截屏"
                    else -> "截屏失败（$errorCode）"
                }
                latch.countDown()
            }
        })
        if (!latch.await(3, TimeUnit.SECONDS)) throw CaptureException("截屏超时，请重试")
        return frame ?: throw CaptureException(error ?: "截屏失败")
    }
}
