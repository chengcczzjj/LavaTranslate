package com.lavatranslate.app

import android.app.Application
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import com.lavatranslate.app.ocr.PaddleOcr
import com.lavatranslate.app.web.NetBridge
import java.util.concurrent.Executors

class LavaApp : Application() {
    val settings by lazy { SettingsStore(this) }
    val ocr by lazy { PaddleOcr(this) }
    val net by lazy { NetBridge() }

    /** 这个进程里创建过 WebView（网页引擎已载入，之后即使网页都销毁了也还占着内存） */
    @Volatile
    var webEngineLoaded = false

    /** OCR、编码图片等耗时工作 */
    val worker = Executors.newFixedThreadPool(2)

    private val main = Handler(Looper.getMainLooper())
    private val live = LinkedHashSet<WebView>()
    private val shown = HashSet<WebView>()
    private val pauseTimers = Runnable { if (shown.isEmpty()) live.firstOrNull()?.pauseTimers() }

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    /**
     * 省电：网页不在屏幕上时暂停渲染（onPause）；所有网页都不在屏幕上时再停掉 JS 定时器（pauseTimers 对整个进程生效）。
     * 暂停前留一点时间让网页做完收尾（关闭后清理状态等）。只在主线程调用。
     */
    fun webVisible(web: WebView, visible: Boolean) {
        live.add(web)
        if (visible) {
            main.removeCallbacks(pauseTimers)
            shown.add(web)
            web.onResume()
            web.resumeTimers()
            return
        }
        shown.remove(web)
        main.postDelayed({ if (web in live && web !in shown) web.onPause() }, PAUSE_DELAY)
        if (shown.isEmpty()) {
            main.removeCallbacks(pauseTimers)
            main.postDelayed(pauseTimers, PAUSE_DELAY)
        }
    }

    /**
     * 退出后结束进程：WebView 引擎、OCR 运行库占的几百 MB 内存要进程结束才会还给系统
     * （开着无障碍时，系统会立刻以最小的样子重新拉起进程，只带无障碍服务）。正在检查、下载或安装更新、
     * 或翻译界面正开着时不结束。
     */
    fun endProcessSoon() {
        main.postDelayed({
            val s = com.lavatranslate.app.update.Updater.state().optString("state")
            val updating = s == "checking" || s == "downloading" || s == "installing"
            // 这期间又打开了悬浮球或设置页：不结束
            val settingsOpen = MainActivity.instance?.isFinishing == false
            val translating = com.lavatranslate.app.capture.LavaAccessibilityService.instance?.active == true
            if (!updating && FloatService.instance == null && !settingsOpen && !translating) android.os.Process.killProcess(android.os.Process.myPid())
        }, 800)
    }

    /** 网页销毁前调用 */
    fun webGone(web: WebView) {
        live.remove(web)
        shown.remove(web)
    }

    companion object {
        private const val PAUSE_DELAY = 1500L

        lateinit var instance: LavaApp
            private set
    }
}
