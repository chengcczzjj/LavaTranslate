package com.lavatranslate.app.ocr

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.RectF
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.nio.FloatBuffer
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * PP-OCRv6 (small) 检测 + 识别：与桌面版 src/main/ocr.ts 同一套模型和前后处理（逐行移植），
 * 推理用 ONNX Runtime 的 CPU 后端。手机截图分辨率高、文字大，检测图最长边限制在 [detLimit]。
 */
class PaddleOcr(private val ctx: Context, private val threads: Int = min(4, Runtime.getRuntime().availableProcessors())) {
    private val env = OrtEnvironment.getEnvironment()
    private lateinit var det: OrtSession
    private lateinit var rec: OrtSession
    private lateinit var dict: Array<String>
    private var recArgmax = false
    private var initialized = false

    /** 检测图最长边（物理像素） */
    var detLimit = 1280

    /** 最近一次识别各阶段耗时（ms） */
    @Volatile
    var timing: Map<String, Long> = emptyMap()

    class Line(val id: Int, val text: String, val score: Float, val box: RectF, val vertical: Boolean, val cx: FloatArray?) {
        fun json(): JSONObject = JSONObject()
            .put("id", id)
            .put("text", text)
            .put("score", (score * 1000).roundToInt() / 1000.0)
            .put("box", JSONObject().put("x", r1(box.left)).put("y", r1(box.top)).put("w", r1(box.width())).put("h", r1(box.height())))
            .apply {
                if (vertical) put("vertical", true)
                if (cx != null) put("cx", JSONArray().apply { cx.forEach { put(r1(it)) } })
            }
    }

    private class Box(val rect: RectF, val vertical: Boolean)

    @Synchronized
    fun init() {
        if (initialized) return
        // 只用 CPU 后端：XNNPACK 在 ORT 1.30 的线程池里会崩溃（SIGSEGV）；NNAPI 已被系统弃用且常比 CPU 慢
        val opts = OrtSession.SessionOptions().apply {
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            setIntraOpNumThreads(threads)
        }
        det = env.createSession(asset("models/det.onnx"), opts)
        rec = env.createSession(asset("models/rec.onnx"), opts)
        recArgmax = rec.outputNames.contains("best_idx")
        val lines = String(asset("models/rec_dict.txt"), Charsets.UTF_8).split(Regex("\r?\n")).toMutableList()
        if (lines.isNotEmpty() && lines.last().isEmpty()) lines.removeAt(lines.size - 1)
        // CTC: 0 = blank, 1..N = 字典, N+1 = 空格
        dict = (listOf("") + lines + listOf(" ")).toTypedArray()
        initialized = true
        // 预热：第一次推理要分配内存、选算法，比之后慢一倍；用一张有几行"字"的假图先跑一遍
        val w = 720
        val h = 1280
        val img = ByteArray(w * h * 4) { -1 }
        for (row in 0 until 6) for (y in 200 + row * 160 until 200 + row * 160 + 28) for (x in 60 until 660 step 3) {
            val i = (y * w + x) * 4
            img[i] = 0
            img[i + 1] = 0
            img[i + 2] = 0
        }
        runCatching { recognize(img, w, h) }
    }

    @Synchronized
    fun close() {
        if (!initialized) return
        det.close()
        rec.close()
        initialized = false
    }

    private fun asset(path: String) = ctx.assets.open(path).use { it.readBytes() }

    @Synchronized
    fun recognize(data: ByteArray, w: Int, h: Int): List<Line> {
        init()
        val t0 = SystemClock.elapsedRealtime()
        val boxes = detect(data, w, h)
        val t1 = SystemClock.elapsedRealtime()
        if (boxes.isEmpty()) {
            timing = mapOf("det" to t1 - t0, "rec" to 0L)
            return emptyList()
        }
        val texts = recognizeBoxes(data, w, h, boxes)
        timing = mapOf("det" to t1 - t0, "rec" to SystemClock.elapsedRealtime() - t1)
        // 低置信度的行也保留位置，由模型看图补全（例如 OCR 不支持的文字）
        return boxes.mapIndexed { i, b ->
            Line(i + 1, texts[i].text, texts[i].score, b.rect, b.vertical, if (b.vertical) null else texts[i].cx)
        }
    }

    // ---------------------------------------------------------------- 检测
    private fun detect(data: ByteArray, W: Int, H: Int): List<Box> {
        val longSide = max(W, H)
        var scale = min(2f, max(1f, 960f / longSide))
        scale = min(scale, detLimit.toFloat() / longSide)
        scale = min(scale, (DET_MAX_SIDE - DET_PAD * 2f) / longSide)
        val cw = (W * scale).roundToInt()
        val ch = (H * scale).roundToInt()
        val dw = ceil((cw + DET_PAD * 2) / 32f).toInt() * 32
        val dh = ceil((ch + DET_PAD * 2) / 32f).toInt() * 32
        val plane = dw * dh
        val input = FloatArray(3 * plane)
        val lb = DET_LUT[0]
        val lg = DET_LUT[1]
        val lr = DET_LUT[2]

        // 留白用边缘像素均值填充
        val bg = borderMean(data, W, H)
        input.fill(lb[bg[2]], 0, plane)
        input.fill(lg[bg[1]], plane, 2 * plane)
        input.fill(lr[bg[0]], 2 * plane, 3 * plane)

        if (cw == W && ch == H) {
            for (y in 0 until H) {
                var s = y * W * 4
                var d = (y + DET_PAD) * dw + DET_PAD
                for (x in 0 until W) {
                    input[d] = lb[u(data[s + 2])]
                    input[plane + d] = lg[u(data[s + 1])]
                    input[2 * plane + d] = lr[u(data[s])]
                    s += 4
                    d++
                }
            }
        } else {
            val cols = Axis(cw, W.toFloat(), 0f, W)
            val rows = Axis(ch, H.toFloat(), 0f, H)
            for (y in 0 until ch) {
                val r0 = rows.i0[y] * W
                val r1 = rows.i1[y] * W
                val ay = rows.a[y]
                var d = (y + DET_PAD) * dw + DET_PAD
                for (x in 0 until cw) {
                    val ax = cols.a[x]
                    val p00 = (r0 + cols.i0[x]) * 4
                    val p10 = (r0 + cols.i1[x]) * 4
                    val p01 = (r1 + cols.i0[x]) * 4
                    val p11 = (r1 + cols.i1[x]) * 4
                    input[d] = lb[bilerp(data, p00 + 2, p10 + 2, p01 + 2, p11 + 2, ax, ay)]
                    input[plane + d] = lg[bilerp(data, p00 + 1, p10 + 1, p01 + 1, p11 + 1, ax, ay)]
                    input[2 * plane + d] = lr[bilerp(data, p00, p10, p01, p11, ax, ay)]
                    d++
                }
            }
        }

        val prob = FloatArray(plane)
        OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, 3, dh.toLong(), dw.toLong())).use { t ->
            det.run(mapOf(det.inputNames.first() to t)).use { res ->
                (res.get(0) as OnnxTensor).floatBuffer.get(prob)
            }
        }

        // 积分图，用于 O(1) 求框内平均概率
        val iw = dw + 1
        val integ = DoubleArray(iw * (dh + 1))
        for (y in 0 until dh) {
            var row = 0.0
            val o = y * dw
            val a = y * iw
            val b = (y + 1) * iw
            for (x in 0 until dw) {
                row += prob[o + x]
                integ[b + x + 1] = integ[a + x + 1] + row
            }
        }

        // 8 邻域连通域
        val seen = BooleanArray(plane)
        val stack = IntArray(plane)
        val boxes = ArrayList<Box>()
        for (start in 0 until plane) {
            if (seen[start] || prob[start] <= DET_THRESH) continue
            var sp = 0
            stack[sp++] = start
            seen[start] = true
            var minX = dw
            var minY = dh
            var maxX = 0
            var maxY = 0
            var area = 0
            while (sp > 0) {
                val p = stack[--sp]
                val px = p % dw
                val py = p / dw
                area++
                if (px < minX) minX = px
                if (px > maxX) maxX = px
                if (py < minY) minY = py
                if (py > maxY) maxY = py
                val yA = if (py > 0) py - 1 else 0
                val yB = if (py < dh - 1) py + 1 else py
                val xA = if (px > 0) px - 1 else 0
                val xB = if (px < dw - 1) px + 1 else px
                for (ny in yA..yB) {
                    var q = ny * dw + xA
                    for (nx in xA..xB) {
                        if (!seen[q] && prob[q] > DET_THRESH) {
                            seen[q] = true
                            stack[sp++] = q
                        }
                        q++
                    }
                }
            }
            val bw = maxX - minX + 1
            val bh = maxY - minY + 1
            if (min(bw, bh) < 3 || area < 6) continue
            val sum = integ[(maxY + 1) * iw + maxX + 1] - integ[minY * iw + maxX + 1] - integ[(maxY + 1) * iw + minX] + integ[minY * iw + minX]
            if (sum / (bw * bh) < DET_BOX_THRESH) continue
            // DB unclip：按面积/周长外扩
            val dd = (bw * bh * DET_UNCLIP) / (2f * (bw + bh))
            val x0 = (minX - dd - DET_PAD) / scale
            val y0 = (minY - dd - DET_PAD) / scale
            val x1 = (maxX + 1 + dd - DET_PAD) / scale
            val y1 = (maxY + 1 + dd - DET_PAD) / scale
            val rx = max(0f, x0)
            val ry = max(0f, y0)
            val rw = min(W.toFloat(), x1) - rx
            val rh = min(H.toFloat(), y1) - ry
            if (rw < 4 || rh < 4) continue
            boxes.add(Box(RectF(r1(rx), r1(ry), r1(rx) + r1(rw), r1(ry) + r1(rh)), rh >= rw * 2 && rw >= 10))
        }
        return sortReadingOrder(boxes)
    }

    // ---------------------------------------------------------------- 识别
    private class Rec(val text: String, val score: Float, val cx: FloatArray)
    private class Item(val i: Int, val ratio: Float)
    private class Decoded(val chars: List<String>, val steps: List<Int>, val score: Float)

    private fun recognizeBoxes(data: ByteArray, W: Int, H: Int, boxes: List<Box>): List<Rec> {
        val items = boxes.mapIndexed { i, b ->
            val w = if (b.vertical) b.rect.height() else b.rect.width()
            val h = if (b.vertical) b.rect.width() else b.rect.height()
            Item(i, w / h)
        }.sortedBy { it.ratio }
        val results = arrayOfNulls<Rec>(boxes.size)

        // 宽高比相近的分到一批，按批内最宽者补齐
        var k = 0
        while (k < items.size) {
            val batch = arrayListOf(items[k])
            var maxRatio = max(REC_MIN_W.toFloat() / REC_H, items[k].ratio)
            while (k + batch.size < items.size && batch.size < 24) {
                val r = max(maxRatio, items[k + batch.size].ratio)
                if ((batch.size + 1) * r > 260) break
                batch.add(items[k + batch.size])
                maxRatio = r
            }
            k += batch.size
            val imgW = ceil(REC_H * maxRatio / 8f).toInt() * 8
            val plane = REC_H * imgW
            val input = FloatArray(batch.size * 3 * plane) // 0 即灰色补齐
            batch.forEachIndexed { bi, it -> fillRec(data, W, H, boxes[it.i], it.ratio, imgW, input, bi * 3 * plane) }
            OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(batch.size.toLong(), 3, REC_H.toLong(), imgW.toLong())).use { t ->
                rec.run(mapOf(rec.inputNames.first() to t)).use { res ->
                    if (recArgmax) {
                        val idxT = res.get("best_idx").get() as OnnxTensor
                        val T = idxT.info.shape[1].toInt()
                        val ids = LongArray(batch.size * T).also { idxT.longBuffer.get(it) }
                        val ps = FloatArray(batch.size * T).also { (res.get("best_prob").get() as OnnxTensor).floatBuffer.get(it) }
                        batch.forEachIndexed { bi, it -> results[it.i] = withPositions(decodeIdx(ids, ps, bi * T, T), boxes[it.i], it.ratio, imgW, T) }
                    } else {
                        val out = res.get(0) as OnnxTensor
                        val shape = out.info.shape
                        val T = shape[1].toInt()
                        val C = shape[2].toInt()
                        val probs = FloatArray(batch.size * T * C).also { out.floatBuffer.get(it) }
                        batch.forEachIndexed { bi, it -> results[it.i] = withPositions(decodeProbs(probs, bi * T * C, T, C), boxes[it.i], it.ratio, imgW, T) }
                    }
                }
            }
        }
        return results.map { it!! }
    }

    /** 把一个文字框裁出、缩放到高 48，写进批张量 */
    private fun fillRec(data: ByteArray, W: Int, H: Int, box: Box, ratio: Float, imgW: Int, out: FloatArray, base: Int) {
        val rect = box.rect
        val tw = min(imgW, max(8, ceil(REC_H * ratio).toInt()))
        val plane = REC_H * imgW
        if (!box.vertical) {
            val cols = Axis(tw, rect.width(), rect.left, W)
            val rows = Axis(REC_H, rect.height(), rect.top, H)
            for (y in 0 until REC_H) {
                val r0 = rows.i0[y] * W
                val r1 = rows.i1[y] * W
                val ay = rows.a[y]
                var d = base + y * imgW
                for (x in 0 until tw) {
                    val ax = cols.a[x]
                    val p00 = (r0 + cols.i0[x]) * 4
                    val p10 = (r0 + cols.i1[x]) * 4
                    val p01 = (r1 + cols.i0[x]) * 4
                    val p11 = (r1 + cols.i1[x]) * 4
                    out[d] = REC_LUT[bilerp(data, p00 + 2, p10 + 2, p01 + 2, p11 + 2, ax, ay)]
                    out[d + plane] = REC_LUT[bilerp(data, p00 + 1, p10 + 1, p01 + 1, p11 + 1, ax, ay)]
                    out[d + 2 * plane] = REC_LUT[bilerp(data, p00, p10, p01, p11, ax, ay)]
                    d++
                }
            }
            return
        }
        // 竖排：逆时针旋转 90°，输出的 x 对应原图从下到上
        for (y in 0 until REC_H) {
            for (x in 0 until tw) {
                val fx = clamp(rect.left + ((y + 0.5f) / REC_H) * rect.width() - 0.5f, 0f, W - 1f)
                val fy = clamp(rect.top + rect.height() - ((x + 0.5f) / tw) * rect.height() - 0.5f, 0f, H - 1f)
                val p = (fy.toInt() * W + fx.toInt()) * 4
                val d = base + y * imgW + x
                out[d] = REC_LUT[u(data[p + 2])]
                out[d + plane] = REC_LUT[u(data[p + 1])]
                out[d + 2 * plane] = REC_LUT[u(data[p])]
            }
        }
    }

    private fun decodeIdx(ids: LongArray, ps: FloatArray, off: Int, T: Int): Decoded {
        val chars = ArrayList<String>()
        val steps = ArrayList<Int>()
        var last = 0
        var sum = 0f
        for (t in 0 until T) {
            val c = ids[off + t].toInt()
            if (c != 0 && c != last && c < dict.size && dict[c].isNotEmpty()) {
                chars.add(dict[c])
                steps.add(t)
                sum += ps[off + t]
            }
            last = c
        }
        return Decoded(chars, steps, if (chars.isEmpty()) 0f else sum / chars.size)
    }

    private fun decodeProbs(p: FloatArray, off: Int, T: Int, C: Int): Decoded {
        val chars = ArrayList<String>()
        val steps = ArrayList<Int>()
        var last = 0
        var sum = 0f
        for (t in 0 until T) {
            val o = off + t * C
            var best = 0
            var bestP = p[o]
            for (c in 1 until C) if (p[o + c] > bestP) {
                bestP = p[o + c]
                best = c
            }
            if (best != 0 && best != last && best < dict.size && dict[best].isNotEmpty()) {
                chars.add(dict[best])
                steps.add(t)
                sum += bestP
            }
            last = best
        }
        return Decoded(chars, steps, if (chars.isEmpty()) 0f else sum / chars.size)
    }

    /** 时间步 → 原图中字符中心的横坐标（相对框左边） */
    private fun withPositions(d: Decoded, box: Box, ratio: Float, imgW: Int, T: Int): Rec {
        val tw = min(imgW, max(8, ceil(REC_H * ratio).toInt()))
        val step = imgW.toFloat() / T
        val k = (if (box.vertical) box.rect.height() else box.rect.width()) / tw
        // 去掉首尾空白，位置数组与文本保持一一对应
        var a = 0
        var b = d.chars.size
        while (a < b && d.chars[a].isBlank()) a++
        while (b > a && d.chars[b - 1].isBlank()) b--
        val cx = FloatArray(b - a) { i -> ((d.steps[a + i] + 0.5f) * step * k * 10).roundToInt() / 10f }
        return Rec(d.chars.subList(a, b).joinToString(""), d.score, cx)
    }

    // ---------------------------------------------------------------- 工具
    /** 一维双线性采样表：目标 n 个采样点映射到源区间 [start, start+len) */
    private class Axis(n: Int, len: Float, start: Float, limit: Int) {
        val i0 = IntArray(n)
        val i1 = IntArray(n)
        val a = FloatArray(n)

        init {
            for (k in 0 until n) {
                val f = clamp(start + ((k + 0.5f) * len) / n - 0.5f, 0f, limit - 1f)
                val lo = f.toInt()
                i0[k] = lo
                i1[k] = if (lo + 1 < limit) lo + 1 else lo
                a[k] = f - lo
            }
        }
    }

    companion object {
        private const val DET_THRESH = 0.2f
        private const val DET_BOX_THRESH = 0.45
        private const val DET_UNCLIP = 1.4f
        private const val DET_MAX_SIDE = 3200
        private const val DET_PAD = 16 // 检测图四周留白（检测空间像素），防止贴边文字漏检
        private const val REC_H = 48
        private const val REC_MIN_W = 320

        // 归一化查表：Paddle 按 BGR 通道顺序做 (x/255 - mean) / std
        private val DET_LUT: Array<FloatArray> = Array(3) { c ->
            val mean = floatArrayOf(0.485f, 0.456f, 0.406f)[c]
            val std = floatArrayOf(0.229f, 0.224f, 0.225f)[c]
            FloatArray(256) { v -> (v / 255f - mean) / std }
        }
        private val REC_LUT = FloatArray(256) { v -> v / 127.5f - 1 }

        private fun u(b: Byte) = b.toInt() and 0xFF

        private fun bilerp(d: ByteArray, p00: Int, p10: Int, p01: Int, p11: Int, ax: Float, ay: Float): Int {
            val t = u(d[p00]) + (u(d[p10]) - u(d[p00])) * ax
            val b = u(d[p01]) + (u(d[p11]) - u(d[p01])) * ax
            return (t + (b - t) * ay + 0.5f).toInt()
        }

        private fun clamp(v: Float, lo: Float, hi: Float) = if (v < lo) lo else if (v > hi) hi else v

        private fun r1(v: Float) = (v * 10).roundToInt() / 10f

        private fun borderMean(d: ByteArray, W: Int, H: Int): IntArray {
            var r = 0L
            var g = 0L
            var b = 0L
            var n = 0
            fun add(x: Int, y: Int) {
                val i = (y * W + x) * 4
                r += u(d[i])
                g += u(d[i + 1])
                b += u(d[i + 2])
                n++
            }
            for (x in 0 until W step 2) {
                add(x, 0)
                add(x, H - 1)
            }
            for (y in 0 until H step 2) {
                add(0, y)
                add(W - 1, y)
            }
            return intArrayOf((r.toFloat() / n).roundToInt(), (g.toFloat() / n).roundToInt(), (b.toFloat() / n).roundToInt())
        }

        /** 阅读顺序：先按行（y 中心接近视为同一行），行内从左到右 */
        private fun sortReadingOrder(boxes: List<Box>): List<Box> {
            val sorted = boxes.sortedWith(compareBy<Box>({ it.rect.top }, { it.rect.left }))
            val rows = ArrayList<MutableList<Box>>()
            for (b in sorted) {
                val cy = b.rect.centerY()
                val row = rows.find { r ->
                    val ref = r[0].rect
                    abs(ref.centerY() - cy) < min(ref.height(), b.rect.height()) * 0.5f
                }
                if (row != null) row.add(b) else rows.add(arrayListOf(b))
            }
            rows.sortBy { it[0].rect.top }
            return rows.flatMap { r -> r.sortedBy { it.rect.left } }
        }
    }
}
