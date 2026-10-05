package com.lavatranslate.app.update

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.lavatranslate.app.BuildConfig
import com.lavatranslate.app.FloatService
import com.lavatranslate.app.LavaApp
import com.lavatranslate.app.MainActivity
import com.lavatranslate.app.R
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.TimeUnit

/**
 * 应用内更新：读 GitHub Releases 里的 latest-android.json（发版脚本生成），有新版本就下载 APK（断点续传、SHA-256 校验），
 * 再交给系统安装器（PackageInstaller）。安装需要用户允许「安装未知应用」并确认一次；新旧版本必须是同一个签名。
 * 自动检查：打开应用、悬浮服务启动后每天一次；Wi-Fi 下发现新版本直接在后台下载好，通知栏提示安装。
 */
object Updater {
    private const val MANIFEST = "https://github.com/chengcczzjj/LavaTranslate/releases/latest/download/latest-android.json"
    private const val CHANNEL = "update"
    private const val NOTIFY_ID = 2
    const val EXTRA_UPDATE = "update"

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()
    private val listeners = CopyOnWriteArraySet<(JSONObject) -> Unit>()

    private class Release(val version: String, val code: Int, val url: String, val size: Long, val sha256: String, val notes: String)

    /** idle / checking / latest / available / downloading / ready / installing / error */
    @Volatile
    private var phase = "idle"

    @Volatile
    private var release: Release? = null

    @Volatile
    private var percent = 0

    @Volatile
    private var message = ""

    @Volatile
    private var call: Call? = null

    /** 去系统页面允许「安装未知应用」了：回到应用后接着安装 */
    @Volatile
    var awaitingPermission = false
        private set

    fun state(): JSONObject = JSONObject()
        .put("state", phase)
        .put("version", BuildConfig.VERSION_NAME)
        .put("percent", percent)
        .put("message", message)
        .apply { release?.let { put("next", it.version).put("notes", it.notes).put("size", it.size) } }

    fun onChange(l: (JSONObject) -> Unit) = listeners.add(l)
    fun offChange(l: (JSONObject) -> Unit) = listeners.remove(l)

    private fun set(p: String, msg: String = "") {
        phase = p
        message = msg
        val s = state()
        listeners.forEach { it(s) }
    }

    private val app get() = LavaApp.instance

    /** 调试版可以在设置里指向本机的测试清单 */
    private fun manifestUrl() = if (BuildConfig.DEBUG) app.settings.str("updateManifest").ifEmpty { MANIFEST } else MANIFEST

    /** 距上次检查超过 [minGap] 才自动检查（用户关了自动更新就不查） */
    fun autoCheck(ctx: Context, minGap: Long) {
        if (!app.settings.bool("autoUpdate")) return
        if (System.currentTimeMillis() - app.settings.num("updateCheckedAt").toLong() < minGap) return
        check(ctx, auto = true)
    }

    fun check(ctx: Context, auto: Boolean) {
        if (phase == "checking" || phase == "downloading" || phase == "installing") return
        set("checking")
        app.worker.execute {
            try {
                val json = client.newCall(Request.Builder().url(manifestUrl()).build()).execute().use { res ->
                    // 还没有发布过安卓版：当作已是最新
                    if (res.code == 404) null
                    else if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
                    else JSONObject(res.body.string())
                }
                app.settings.update(JSONObject().put("updateCheckedAt", System.currentTimeMillis()))
                if (json == null || json.optInt("versionCode") <= BuildConfig.VERSION_CODE) {
                    release = null
                    return@execute set("latest")
                }
                val r = Release(
                    json.getString("version"), json.getInt("versionCode"), json.getString("url"),
                    json.getLong("size"), json.getString("sha256").lowercase(), json.optString("notes")
                )
                release = r
                val apk = apkFile(ctx, r)
                if (apk.exists() && apk.length() == r.size) {
                    set("ready")
                    if (auto) notifyUpdate(ctx, r, ready = true)
                } else {
                    set("available")
                    // Wi-Fi 下自动下载好；流量下只提示
                    if (auto && !metered(ctx)) download(ctx) else if (auto) notifyUpdate(ctx, r, ready = false)
                }
            } catch (e: Exception) {
                if (auto) set("idle") else set("error", "检查更新失败：${e.message ?: "网络错误"}（需要能访问 GitHub）")
            }
        }
    }

    fun download(ctx: Context) {
        val r = release ?: return
        if (phase == "downloading" || phase == "installing") return
        percent = 0
        set("downloading")
        app.worker.execute {
            val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
            val part = File(dir, "LavaTranslate-${r.version}.apk.part")
            // 其他版本的残留
            dir.listFiles()?.forEach { if (it.name != part.name) it.delete() }
            var c: Call? = null
            try {
                var have = if (part.exists()) part.length() else 0L
                if (have >= r.size) {
                    part.delete()
                    have = 0
                }
                val req = Request.Builder().url(r.url).apply { if (have > 0) header("Range", "bytes=$have-") }.build()
                c = client.newCall(req)
                call = c
                c.execute().use { res ->
                    if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
                    // 服务器不支持续传：从头下载
                    if (res.code != 206) have = 0
                    FileOutputStream(part, have > 0).use { out ->
                        val src = res.body.byteStream()
                        val buf = ByteArray(64 * 1024)
                        var done = have
                        var last = 0L
                        while (true) {
                            val n = src.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            done += n
                            val now = System.currentTimeMillis()
                            if (now - last > 250) {
                                last = now
                                percent = (done * 100 / r.size).toInt().coerceIn(0, 99)
                                set("downloading")
                            }
                        }
                    }
                }
                if (part.length() != r.size) throw IOException("文件不完整，请重试")
                if (sha256(part) != r.sha256) {
                    part.delete()
                    throw IOException("文件校验失败，请重试")
                }
                part.renameTo(apkFile(ctx, r))
                percent = 100
                set("ready")
                notifyUpdate(ctx, r, ready = true)
            } catch (e: Exception) {
                if (c?.isCanceled() == true) set("available") else set("error", "下载失败：${e.message ?: "网络错误"}")
            } finally {
                call = null
            }
        }
    }

    fun cancel() {
        call?.cancel()
    }

    /** 交给系统安装器。返回 "permission" 表示先去允许「安装未知应用」 */
    fun install(activity: Activity): String {
        val r = release ?: return "none"
        val apk = apkFile(activity, r)
        if (!apk.exists()) return "none"
        if (!activity.packageManager.canRequestPackageInstalls()) {
            awaitingPermission = true
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
            return "permission"
        }
        awaitingPermission = false
        // 装好后重新打开设置页（静默更新时旧进程直接被关掉，界面会消失）
        app.settings.update(JSONObject().put("updateRelaunch", true))
        set("installing")
        app.worker.execute {
            try {
                val pi = activity.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(activity.packageName)
                    setSize(apk.length())
                    // 本应用装过一次之后，再更新可以不弹确认（系统允许时）
                    if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                    if (Build.VERSION.SDK_INT >= 33) setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
                }
                val id = pi.createSession(params)
                pi.openSession(id).use { s ->
                    s.openWrite("base.apk", 0, apk.length()).use { out ->
                        apk.inputStream().use { it.copyTo(out) }
                        s.fsync(out)
                    }
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                    val result = PendingIntent.getBroadcast(activity, id, Intent(activity, UpdateReceiver::class.java), flags)
                    s.commit(result.intentSender)
                }
            } catch (e: Exception) {
                set("error", "安装失败：${e.message}")
            }
        }
        return "ok"
    }

    internal fun installResult(ctx: Context, status: Int, msg: String?) {
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> set("latest")
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                app.settings.update(JSONObject().put("updateRelaunch", false))
                set("ready", "已取消安装")
            }
            PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                set("error", "安装失败：新版本的签名与已安装的不一致，需要先卸载旧版再安装（只有第一次换成正式签名时会这样）")
            else -> set("error", "安装失败：${msg ?: status}")
        }
        if (status != PackageInstaller.STATUS_SUCCESS) ctx.getSystemService(NotificationManager::class.java).cancel(NOTIFY_ID)
    }

    private fun apkFile(ctx: Context, r: Release) = File(File(ctx.cacheDir, "updates"), "LavaTranslate-${r.version}.apk")

    private fun metered(ctx: Context) = ctx.getSystemService(ConnectivityManager::class.java).isActiveNetworkMetered

    private fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(256 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun notifyUpdate(ctx: Context, r: Release, ready: Boolean) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "更新", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            ctx, 3, Intent(ctx, MainActivity::class.java).putExtra(EXTRA_UPDATE, true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val n = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle(if (ready) "LavaTranslate ${r.version} 已下载" else "LavaTranslate 有新版本 ${r.version}")
            .setContentText(if (ready) "点击安装更新" else "点击下载并安装")
            .setContentIntent(open)
            .setAutoCancel(true)
            .setColor(0xFFE23E9A.toInt())
            .build()
        runCatching { nm.notify(NOTIFY_ID, n) }
    }
}

/** 系统安装器的结果：需要用户确认时弹出确认页 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
            confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { ctx.startActivity(it) }
            return
        }
        Updater.installResult(ctx, status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
    }
}

/** 更新装好后：清掉安装包，之前开着悬浮球就恢复 */
class ReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        File(ctx.cacheDir, "updates").deleteRecursively()
        val app = LavaApp.instance
        if (app.settings.bool("bubbleEnabled") && Settings.canDrawOverlays(ctx)) runCatching { FloatService.start(ctx) }
        // 用户在设置页点的更新：装好后回到设置页（有「显示在其他应用上层」权限才允许从后台打开界面）
        if (app.settings.bool("updateRelaunch")) {
            app.settings.update(JSONObject().put("updateRelaunch", false))
            if (Settings.canDrawOverlays(ctx)) runCatching {
                ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }
}
