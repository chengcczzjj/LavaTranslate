package com.lavatranslate.app.capture

import android.graphics.Rect

/** 一帧截图：RGBA 像素（紧密排列，无行填充） */
class Frame(
    val id: Int,
    val width: Int,
    val height: Int,
    val rgba: ByteArray,
    /** 要识别、翻译的区域（物理像素）：去掉状态栏与底部导航条 */
    val content: Rect,
    val density: Float
) {
    fun crop(r: Rect): ByteArray {
        if (r.left == 0 && r.top == 0 && r.width() == width && r.height() == height) return rgba
        val out = ByteArray(r.width() * r.height() * 4)
        val row = r.width() * 4
        for (y in 0 until r.height()) System.arraycopy(rgba, ((r.top + y) * width + r.left) * 4, out, y * row, row)
        return out
    }
}

interface ScreenCapturer {
    /** 阻塞直到拿到一帧；在后台线程调用 */
    fun capture(): Frame
}

class CaptureException(message: String) : Exception(message)
