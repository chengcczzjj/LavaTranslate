package com.lavatranslate.app.capture

import android.accessibilityservice.AccessibilityButtonController
import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import com.lavatranslate.app.LavaApp
import com.lavatranslate.app.LiveHost
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 无障碍模式（推荐）：整个翻译功能都在这个服务里，用户在系统「无障碍」里打开一次后一直可用，开机由系统拉起。
 * 不需要悬浮窗权限、前台服务和常驻通知；界面（悬浮面板、小胶囊、译文层）都在无障碍图层上，见 [LiveHost]。
 * 唤出：点 LavaTranslate 图标、系统无障碍按钮（音量键快捷方式）、下拉快捷开关。
 * 截屏用 takeScreenshot（不弹授权）；文字优先直接从界面节点读，只在翻译时读。
 * 平时不订阅任何界面事件，只在实时翻译时订阅滚动、换页（LiveHost.subscribe）。
 */
class LavaAccessibilityService : AccessibilityService() {
    private val main = Handler(Looper.getMainLooper())
    var host: LiveHost? = null
        private set

    private val button = object : AccessibilityButtonController.AccessibilityButtonCallback() {
        override fun onClicked(controller: AccessibilityButtonController) {
            host?.togglePanel()
        }
    }

    /** 正在翻译或写回复 */
    val active get() = host?.active == true

    override fun onServiceConnected() {
        instance = this
        host = LiveHost(this)
        accessibilityButtonController.registerAccessibilityButtonCallback(button, main)
    }

    override fun onDestroy() {
        runCatching { accessibilityButtonController.unregisterAccessibilityButtonCallback(button) }
        host?.destroy()
        host = null
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event != null) host?.onEvent(event)
    }

    override fun onInterrupt() {}

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        host?.onConfigurationChanged()
    }

    // ------------------------------------------------------------ 唤出
    /** 下拉快捷开关：先收起通知栏，等它收完再开始 */
    fun translateFromShade() = fromShade { it.startLive() }

    fun quickFromShade() = fromShade { it.quick() }

    /** 稍后打开（等中转页面、通知栏收起） */
    fun later(quick: Boolean, delay: Long) = main.postDelayed({ host?.let { if (quick) it.quick() else it.startLive() } }, delay)

    private fun fromShade(run: (LiveHost) -> Unit) {
        if (Build.VERSION.SDK_INT >= 31) performGlobalAction(GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        main.postDelayed({ host?.let(run) }, SHADE_MS)
    }

    companion object {
        /** 等通知栏收起的时间 */
        private const val SHADE_MS = 420L

        @Volatile
        var instance: LavaAccessibilityService? = null
            private set

        val supported get() = Build.VERSION.SDK_INT >= 30

        /** 设置里选的是无障碍模式 */
        val mode get() = LavaApp.instance.settings.str("captureMode") == "accessibility"

        /** 系统设置里是否已打开（服务可能还没连上） */
        fun enabled(ctx: Context) = listed(ctx, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)

        /**
         * 系统的无障碍按钮（导航栏里的小人图标，或全面屏手势下贴边的悬浮按钮）指给了本服务。
         * 不用 AccessibilityButtonController.isAccessibilityButtonAvailable：它只认导航栏里的按钮，悬浮按钮时总是 false
         */
        fun buttonAssigned(ctx: Context) = listed(ctx, "accessibility_button_targets")

        /** 「同时按住两个音量键」快捷方式指给了本服务 */
        fun volumeAssigned(ctx: Context) = listed(ctx, "accessibility_shortcut_target_service")

        private fun listed(ctx: Context, key: String): Boolean {
            val list = runCatching { Settings.Secure.getString(ctx.contentResolver, key) }.getOrNull() ?: return false
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
