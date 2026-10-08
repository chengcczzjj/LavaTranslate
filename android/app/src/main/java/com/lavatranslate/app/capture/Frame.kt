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
    /**
     * 把一块区域（自己的小胶囊）抹成旁边的颜色，免得 OCR 把它当成文字、模型也看不到它。
     * 每一行取区域左边（贴左边缘时取右边）紧挨着的像素来填
     */
    fun fill(area: Rect) {
        val r = Rect(area)
        if (!r.intersect(0, 0, width, height)) return
        for (y in r.top until r.bottom) {
            val sx = if (r.left > 0) r.left - 1 else if (r.right < width) r.right else return
            val si = (y * width + sx) * 4
            for (x in r.left until r.right) System.arraycopy(rgba, si, rgba, (y * width + x) * 4, 4)
        }
    }

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
