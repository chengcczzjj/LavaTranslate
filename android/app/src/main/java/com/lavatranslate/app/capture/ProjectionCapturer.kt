package com.lavatranslate.app.capture

import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * 系统截屏授权（MediaProjection）。Android 14 起每个会话都要用户点一次同意、只能建一个虚拟显示器；
 * 会话保持期间可以截任意多帧。平时虚拟显示器不接画面（setSurface(null)），截屏时才接上 ImageReader，
 * 拿到一帧立刻断开，避免一直镜像屏幕耗电。锁屏、用户点状态栏停止共享等都会结束会话（onStop）。
 */
class ProjectionCapturer(private val ctx: Context, private val onStopped: () -> Unit) : ScreenCapturer {
    private val thread = HandlerThread("lava-capture").apply { start() }
    private val handler = Handler(thread.looper)
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var reader: ImageReader? = null

    val active: Boolean get() = projection != null

    fun start(resultCode: Int, data: Intent) {
        stop()
        val mpm = ctx.getSystemService(MediaProjectionManager::class.java)
        val mp = mpm.getMediaProjection(resultCode, data) ?: throw CaptureException("没有拿到截屏授权")
        // Android 14 起必须先注册回调再建虚拟显示器
        mp.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                release()
                onStopped()
            }
        }, handler)
        projection = mp
        val size = Screen.size(ctx)
        val r = ImageReader.newInstance(size.x, size.y, PixelFormat.RGBA_8888, 2)
        reader = r
        display = mp.createVirtualDisplay(
            "LavaTranslate", size.x, size.y, ctx.resources.displayMetrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, null, null, handler
        )
    }

    fun stop() {
        val mp = projection
        release()
        mp?.stop()
    }

    private fun release() {
        projection = null
        display?.release()
        display = null
        reader?.close()
        reader = null
    }

    override fun capture(): Frame {
        val vd = display ?: throw CaptureException("截屏授权已失效")
        var r = reader ?: throw CaptureException("截屏授权已失效")
        // 转屏：同一个虚拟显示器改尺寸（不能新建），换一个对应尺寸的 ImageReader
        val size = Screen.size(ctx)
        if (size.x != r.width || size.y != r.height) {
            r.close()
            r = ImageReader.newInstance(size.x, size.y, PixelFormat.RGBA_8888, 2)
            reader = r
            vd.resize(size.x, size.y, ctx.resources.displayMetrics.densityDpi)
        }
        val latch = CountDownLatch(1)
        var image: Image? = null
        r.setOnImageAvailableListener({ ir ->
            val img = ir.acquireLatestImage() ?: return@setOnImageAvailableListener
            if (image == null) {
                image = img
                latch.countDown()
            } else img.close()
        }, handler)
        vd.surface = r.surface
        val ok = latch.await(1500, TimeUnit.MILLISECONDS)
        vd.surface = null
        r.setOnImageAvailableListener(null, null)
        val img = image ?: throw CaptureException(if (ok) "截屏失败" else "截屏超时，请重试")
        try {
            return toFrame(img)
        } finally {
            img.close()
        }
    }

    private fun toFrame(img: Image): Frame {
        val w = img.width
        val h = img.height
        val plane = img.planes[0]
        val buf = plane.buffer
        val rowStride = plane.rowStride
        val out = ByteArray(w * h * 4)
        if (rowStride == w * 4) buf.get(out, 0, out.size)
        else for (y in 0 until h) {
            buf.position(y * rowStride)
            buf.get(out, y * w * 4, w * 4)
        }
        return Frame(seq.incrementAndGet(), w, h, out, Screen.content(ctx, w, h), ctx.resources.displayMetrics.density)
    }

    companion object {
        val seq = AtomicInteger()
    }
}
