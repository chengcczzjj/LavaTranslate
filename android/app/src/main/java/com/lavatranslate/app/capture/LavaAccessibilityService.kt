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
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.widget.Toast
import com.lavatranslate.app.LavaApp
import com.lavatranslate.app.ScreenHost
import com.lavatranslate.app.update.Updater
import org.json.JSONObject
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 无障碍模式（推荐）：整个翻译功能都在这个服务里，用户在系统「无障碍」里打开一次后一直可用。
 * - 不需要悬浮窗权限、前台服务和常驻通知：悬浮球与翻译界面都是无障碍图层，开机后系统自动拉起本服务；
 * - 唤出方式：自己的悬浮球（可关）、系统的无障碍按钮 / 音量键快捷方式、下拉快捷开关；
 * - 截屏用无障碍的 takeScreenshot，不弹授权、没有共享标识，锁屏也不失效。
 * 不订阅任何界面事件、不读取界面内容（见 res/xml/accessibility_service.xml）：不用时进程里什么都不跑，
 * 翻译界面和 OCR 模型也在用完几分钟后释放（[ScreenHost.WARM_MS]）。
 */
class LavaAccessibilityService : AccessibilityService(), ScreenHost.Owner {
    private val app get() = LavaApp.instance
    private val main = Handler(Looper.getMainLooper())
    private var host: ScreenHost? = null
    private val capturer by lazy { A11yCapturer(this) }
    private val onSettings: () -> Unit = { main.post { syncBubble() } }

    private val button = object : AccessibilityButtonController.AccessibilityButtonCallback() {
        override fun onClicked(controller: AccessibilityButtonController) {
            host?.toggle()
        }

        override fun onAvailabilityChanged(controller: AccessibilityButtonController, available: Boolean) {
            if (available) firstButton()
        }
    }

    override val kind = "a11y"

    /** 翻译界面开着 */
    val active get() = host?.active == true

    override fun onServiceConnected() {
        instance = this
        host = ScreenHost(this, getSystemService(WindowManager::class.java), WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, this)
        accessibilityButtonController.registerAccessibilityButtonCallback(button, main)
        app.settings.onChange(onSettings)
        syncBubble()
        // 系统往往在服务连上之后才把按钮指过来
        main.postDelayed({ if (buttonAssigned(this)) firstButton() }, 1500)
    }

    /**
     * 第一次开启时系统同时给了无障碍按钮：两个球挤在屏幕边上没必要，先只用系统的（它不用时会自动变淡），
     * 悬浮球可以在设置里再打开。之后完全按用户的选择。
     */
    private fun firstButton() {
        if (app.settings.bool("a11yIntroDone")) return
        val patch = JSONObject().put("a11yIntroDone", true)
        if (mode && app.settings.bool("bubbleEnabled")) {
            patch.put("bubbleEnabled", false)
            toast("已用系统的无障碍按钮翻译屏幕 · 想用悬浮球可以在 LavaTranslate 里打开")
        }
        app.settings.update(patch)
    }

    override fun onDestroy() {
        app.settings.offChange(onSettings)
        runCatching { accessibilityButtonController.unregisterAccessibilityButtonCallback(button) }
        host?.destroy()
        host = null
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        host?.placeBubble()
    }

    /** 无障碍模式下才显示自己的悬浮球（截屏授权模式的悬浮球在 FloatService 里） */
    private fun syncBubble() {
        host?.bubbleVisible(mode && app.settings.bool("bubbleEnabled"))
    }

    // ------------------------------------------------------------ 唤出
    /** 下拉快捷开关、通知等：先收起通知栏，等它收完再截屏 */
    fun translateFromShade() = fromShade { it.translate() }

    fun quickFromShade() = fromShade { it.quick() }

    /** 稍后打开（等中转页面、通知栏收起） */
    fun later(quick: Boolean, delay: Long) = main.postDelayed({ host?.let { if (quick) it.quick() else it.translate() } }, delay)

    private fun fromShade(run: (ScreenHost) -> Unit) {
        if (Build.VERSION.SDK_INT >= 31) performGlobalAction(GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        main.postDelayed({ host?.let(run) }, SHADE_MS)
    }

    // ------------------------------------------------------------ ScreenHost.Owner
    override fun capturer(): ScreenCapturer? {
        if (Build.VERSION.SDK_INT < 30) {
            toast("免授权截屏需要 Android 11 或更高版本")
            return null
        }
        return capturer
    }

    /** 菜单里的「隐藏悬浮球」：翻译仍可以用系统无障碍按钮、快捷开关唤出 */
    override fun quit() {
        app.settings.update(JSONObject().put("bubbleEnabled", false))
        host?.release()
        toast(if (buttonAssigned(this) || volumeAssigned(this)) "悬浮球已隐藏 · 仍可用无障碍按钮翻译" else "悬浮球已隐藏 · 可用下拉快捷开关翻译，或在 LavaTranslate 里重新打开")
    }

    /**
     * 关屏时：如果这个进程载入过网页引擎，就结束进程。网页释放后引擎本身还占着一两百 MB，
     * 只有结束进程才能还给系统；系统会立刻以最小的样子（几十 MB，只有本服务）重新拉起它，悬浮球也会回来。
     * 选在关屏时做，用户看不到悬浮球消失又出现。
     */
    override fun screenOff() {
        if (app.webEngineLoaded) app.endProcessSoon()
    }

    override fun closed() {
        // 不常驻的模式没有定时检查更新：用完时顺便看一眼（至多每天一次）
        Updater.autoCheck(this, 20 * 3600_000L)
    }

    private fun toast(text: String) = main.post { Toast.makeText(this, text, Toast.LENGTH_SHORT).show() }

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
