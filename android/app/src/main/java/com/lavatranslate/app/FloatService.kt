package com.lavatranslate.app

import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.Display
import android.view.WindowManager
import android.widget.Toast
import com.lavatranslate.app.capture.LavaAccessibilityService
import com.lavatranslate.app.capture.ProjectionCapturer
import com.lavatranslate.app.capture.ScreenCapturer

/**
 * 截屏授权模式的悬浮球前台服务：悬浮窗里的悬浮球 + 系统截屏授权（MediaProjection）。
 * 翻译界面本身在 [ScreenHost]（与无障碍模式共用）。推荐的无障碍模式不用这个服务，见 LavaAccessibilityService。
 *
 * 省电：不用时不截屏、不联网，网页暂停；关掉翻译界面几分钟后释放网页和 OCR 模型，并结束截屏授权
 * （授权期间状态栏的共享计时每秒刷新一次）。长时间不用、或系统打开省电模式时自动退出（可在设置里关掉），
 * 退出时结束进程，把内存还给系统。
 */
class FloatService : Service(), ScreenHost.Owner {
    private val app get() = LavaApp.instance
    private val main = Handler(Looper.getMainLooper())
    private lateinit var wm: WindowManager
    private lateinit var host: ScreenHost
    lateinit var projection: ProjectionCapturer
        private set

    private val onSettings: () -> Unit = {
        main.post { scheduleIdle() }
    }

    /** 上次使用悬浮球的时间（elapsedRealtime，含休眠），用于「长时间不用自动退出」 */
    private var lastUse = SystemClock.elapsedRealtime()
    private val alarms by lazy { getSystemService(AlarmManager::class.java) }
    private val idleAlarm = AlarmManager.OnAlarmListener { onIdle() }

    /** 翻译界面开着时要退出：等它关掉再退 */
    private var pendingQuit: String? = null
    private val powerSave = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (getSystemService(PowerManager::class.java).isPowerSaveMode && app.settings.bool("saverExit")) quitWhenIdle(REASON_SAVER)
        }
    }

    override val kind = "float"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        startForegroundCompat(false)
        val wctx = if (Build.VERSION.SDK_INT >= 30) {
            val display = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
            createDisplayContext(display).createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
        } else this
        wm = wctx.getSystemService(WindowManager::class.java)
        projection = ProjectionCapturer(this) { main.post { onProjectionStopped() } }
        host = ScreenHost(wctx, wm, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, this)
        if (Settings.canDrawOverlays(this)) host.bubbleVisible(true)
        refreshBadge()
        app.settings.onChange(onSettings)
        // 悬浮球常驻期间每天检查一次更新
        main.postDelayed(updateTick, 60_000)
        androidx.core.content.ContextCompat.registerReceiver(this, powerSave, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED)
        getSystemService(NotificationManager::class.java).cancel(NOTICE_ID)
        used()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> quit()
            ACTION_TRANSLATE -> main.postDelayed({ host.translate() }, intent.getLongExtra(EXTRA_DELAY, 0))
            ACTION_QUICK -> main.postDelayed({ host.quick() }, intent.getLongExtra(EXTRA_DELAY, 0))
        }
        return START_STICKY
    }

    private val updateTick: Runnable = object : Runnable {
        override fun run() {
            com.lavatranslate.app.update.Updater.autoCheck(this@FloatService, 20 * 3600_000L)
            main.postDelayed(this, 3 * 3600_000L)
        }
    }

    override fun onDestroy() {
        main.removeCallbacks(updateTick)
        main.removeCallbacks(stopProjection)
        alarms.cancel(idleAlarm)
        runCatching { unregisterReceiver(powerSave) }
        app.settings.offChange(onSettings)
        host.destroy()
        projection.stop()
        if (instance === this) instance = null
        super.onDestroy()
    }

    // ------------------------------------------------------------ 退出与省电
    /**
     * 彻底退出：关掉悬浮球、常驻通知、截屏授权、翻译界面和设置页，然后结束进程释放内存。
     * 不改「悬浮球」开关：之后点 LavaTranslate 图标会重新打开。reason 不为空表示自动退出，留一条通知说明原因。
     */
    fun quit(reason: String?) {
        if (reason != null) notifyAutoExit(reason)
        SettingsActivity.instance?.finishAndRemoveTask()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        app.endProcessSoon()
    }

    private fun quitWhenIdle(reason: String) {
        if (host.active) pendingQuit = reason else quit(reason)
    }

    /** 用了一次悬浮球：重新计时 */
    override fun used() {
        lastUse = SystemClock.elapsedRealtime()
        main.removeCallbacks(stopProjection)
        scheduleIdle()
    }

    /** 「长时间不用自动退出」的时长（毫秒），0 表示从不 */
    private fun idleLimit(): Long {
        val min = app.settings.num("idleExit")
        return if (min.isNaN() || min <= 0) 0 else (min * 60_000).toLong()
    }

    /** 到点检查一次：允许推迟 10 分钟，方便系统和别的唤醒合并（也不需要精确闹钟权限） */
    private fun scheduleIdle() {
        alarms.cancel(idleAlarm)
        val limit = idleLimit()
        if (limit > 0) alarms.setWindow(AlarmManager.ELAPSED_REALTIME_WAKEUP, lastUse + limit, 10 * 60_000L, "lava:idle", idleAlarm, main)
    }

    private fun onIdle() {
        val limit = idleLimit()
        if (limit <= 0) return
        if (host.active || SystemClock.elapsedRealtime() - lastUse < limit - 1000) return used()
        quit(REASON_IDLE)
    }

    private fun notifyAutoExit(reason: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(NOTICE_CHANNEL, "自动退出提醒", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        val minutes = (idleLimit() / 60_000).toInt()
        val span = if (minutes >= 60 && minutes % 60 == 0) "${minutes / 60} 小时" else "$minutes 分钟"
        val why = if (reason == REASON_IDLE) "${span}没有使用" else "系统省电模式已打开"
        val reopen = PendingIntent.getForegroundService(
            this, 4, Intent(this, FloatService::class.java).setAction(ACTION_START), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val n = Notification.Builder(this, NOTICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle("悬浮球已自动退出")
            .setContentText("${why}，已退出以省电 · 点这里重新打开")
            .setContentIntent(reopen)
            .setAutoCancel(true)
            .setColor(LAVA)
            .setTimeoutAfter(12 * 3600_000L)
            .build()
        nm.notify(NOTICE_ID, n)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // 转屏后按保存的一侧、高度比例重新摆放
        host.placeBubble()
    }

    private fun refreshBadge() = host.badge(needsConsent)

    val needsConsent get() = !projection.active

    /** 稍后翻译（等通知栏、中转页面收起） */
    fun translateLater(delay: Long) = main.postDelayed({ host.translate() }, delay)

    fun quickLater(delay: Long) = main.postDelayed({ host.quick() }, delay)

    // ------------------------------------------------------------ 截屏授权
    fun requestConsent(thenTranslate: Boolean) {
        startActivity(Intent(this, ConsentActivity::class.java).putExtra(ConsentActivity.EXTRA_TRANSLATE, thenTranslate).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** 授权结果（来自 ConsentActivity）；thenTranslate：授权后接着翻译 */
    fun onConsent(resultCode: Int, data: Intent?, thenTranslate: Boolean) {
        if (resultCode != Activity.RESULT_OK || data == null) {
            toast("没有授权截屏")
            return
        }
        try {
            // Android 14 起：拿到授权后、创建会话前，前台服务要带上 mediaProjection 类型
            startForegroundCompat(true)
            projection.start(resultCode, data)
        } catch (e: Exception) {
            startForegroundCompat(false)
            toast(e.message ?: "截屏授权失败")
            return
        }
        refreshBadge()
        used()
        // 等系统授权框完全消失再截屏
        if (thenTranslate) main.postDelayed({ host.translate() }, 450)
    }

    private fun onProjectionStopped() {
        startForegroundCompat(false)
        refreshBadge()
    }

    /** 关掉翻译界面后一直没再用：结束截屏授权（授权期间状态栏的共享计时每秒刷新，屏幕没法降到最低刷新率） */
    private val stopProjection = Runnable { if (!host.active) projection.stop() }

    // ------------------------------------------------------------ ScreenHost.Owner
    override fun ready(): Boolean {
        if (Settings.canDrawOverlays(this)) return true
        openMain()
        return false
    }

    override fun capturer(): ScreenCapturer? {
        if (!projection.active) {
            requestConsent(true)
            return null
        }
        return projection
    }

    override fun quit() = quit(null)

    override fun closed() {
        main.removeCallbacks(stopProjection)
        main.postDelayed(stopProjection, PROJECTION_IDLE_MS)
        pendingQuit?.let { main.post { quit(it) } }
    }

    // ------------------------------------------------------------ 杂项
    private fun openMain() {
        startActivity(Intent(this, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun toast(text: String) = main.post { Toast.makeText(this, text, Toast.LENGTH_SHORT).show() }

    private fun createChannel() {
        val ch = NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW).apply {
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun notification(): Notification {
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val open = PendingIntent.getActivity(this, 0, Intent(this, SettingsActivity::class.java), flags)
        // 从通知栏点「翻译屏幕」要先收起通知栏：经由透明页面中转，它会让通知栏收起
        val translate = PendingIntent.getActivity(this, 1, Intent(this, ConsentActivity::class.java).putExtra(ConsentActivity.EXTRA_TRANSLATE, true), flags)
        val stop = PendingIntent.getService(this, 2, Intent(this, FloatService::class.java).setAction(ACTION_STOP), flags)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle("悬浮球已开启")
            .setContentText("点悬浮球翻译屏幕，长按打开菜单")
            .setContentIntent(open)
            .setOngoing(true)
            .setColor(LAVA)
            .addAction(Notification.Action.Builder(null, "翻译屏幕", translate).build())
            .addAction(Notification.Action.Builder(null, "退出", stop).build())
            .build()
    }

    private fun startForegroundCompat(withProjection: Boolean) {
        val n = notification()
        when {
            Build.VERSION.SDK_INT >= 34 -> startForeground(
                NOTIFICATION_ID, n,
                if (withProjection) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                else ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
            else -> startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        }
    }

    companion object {
        const val ACTION_STOP = "com.lavatranslate.app.STOP"
        const val ACTION_TRANSLATE = "com.lavatranslate.app.TRANSLATE"
        const val ACTION_QUICK = "com.lavatranslate.app.QUICK"
        const val ACTION_START = "com.lavatranslate.app.START"
        const val EXTRA_DELAY = "delay"
        private const val CHANNEL = "bubble"
        private const val NOTIFICATION_ID = 1
        private const val NOTICE_CHANNEL = "notice"
        private const val NOTICE_ID = 2
        private const val REASON_IDLE = "idle"
        private const val REASON_SAVER = "saver"

        /** 关掉翻译界面后这么久没再用，就结束截屏授权 */
        private const val PROJECTION_IDLE_MS = 5 * 60_000L

        /** 熔岩色（与图标一致） */
        const val LAVA = 0xFFFF5A1F.toInt()

        @Volatile
        var instance: FloatService? = null
            private set

        /** 截屏授权模式、开着悬浮球、有悬浮窗权限：悬浮球服务应该在运行 */
        fun wanted(ctx: Context) = !LavaAccessibilityService.mode && LavaApp.instance.settings.bool("bubbleEnabled") && Settings.canDrawOverlays(ctx)

        fun start(ctx: Context, action: String? = null, delay: Long = 0) {
            ctx.startForegroundService(Intent(ctx, FloatService::class.java).setAction(action).putExtra(EXTRA_DELAY, delay))
        }
    }
}
