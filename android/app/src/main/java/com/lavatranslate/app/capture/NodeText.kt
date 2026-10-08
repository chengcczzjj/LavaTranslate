package com.lavatranslate.app.capture

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Region
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import kotlin.math.min

/**
 * 从无障碍节点直接读屏幕上的文字：逐行、带精确位置（每个字的位置由应用自己给出），不用截图做 OCR。
 * 普通界面（原生控件、网页、Compose）都能读到；游戏、图片里的字读不到，由调用方退回 OCR。
 */
object NodeText {
    class Line(val text: String, val box: RectF)

    class Result(
        val lines: List<Line>,
        /** 读不到逐字位置、又不止一行的文字节点数（多了就该退回 OCR） */
        val unknown: Int,
        /** 内容指纹：文字和位置都没变就不必重新翻译 */
        val signature: Int
    )

    private const val MAX_NODES = 4000
    private const val MAX_CHARS = 4000

    /** content：要翻译的区域（屏幕坐标）；skip：自己的窗口（小胶囊等）挡住的地方，不读 */
    fun read(svc: AccessibilityService, content: Rect, density: Float): Result {
        val lines = ArrayList<Line>()
        var unknown = 0
        // 窗口按层级从上到下：被上层窗口（弹窗、菜单）盖住的字不读
        val covered = Region()
        val wb = Rect()
        for (w in svc.windows) {
            w.getBoundsInScreen(wb)
            val app = w.type == AccessibilityWindowInfo.TYPE_APPLICATION
            if (app) {
                val root = if (Build.VERSION.SDK_INT >= 33) w.getRoot(AccessibilityNodeInfo.FLAG_PREFETCH_DESCENDANTS_HYBRID) else w.root
                if (root != null && root.packageName != svc.packageName) unknown += walk(root, content, covered, density, lines)
            }
            // 输入法、系统栏也会挡住下面的字；自己的无障碍图层（翻译层、胶囊）不算
            if (w.type != AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) covered.union(wb)
        }
        lines.sortWith(compareBy<Line>({ it.box.top.toInt() / (8 * density).toInt() }, { it.box.left }))
        var sig = 17
        for (l in lines) sig = sig * 31 + l.text.hashCode() * 7 + l.box.top.toInt() / 4 * 3 + l.box.left.toInt() / 4
        return Result(lines, unknown, sig)
    }

    private fun walk(root: AccessibilityNodeInfo, content: Rect, covered: Region, density: Float, out: MutableList<Line>): Int {
        var unknown = 0
        var visited = 0
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.add(root)
        val r = Rect()
        while (stack.isNotEmpty() && visited < MAX_NODES) {
            val n = stack.removeLast()
            visited++
            if (!n.isVisibleToUser) continue
            for (i in n.childCount - 1 downTo 0) n.getChild(i)?.let { stack.add(it) }
            val text = n.text ?: continue
            // 输入框（用户自己在写的内容）、密码不翻
            if (text.isBlank() || n.isPassword || n.isEditable) continue
            n.getBoundsInScreen(r)
            if (!r.intersect(content) || r.isEmpty) continue
            if (covered.contains(r.centerX(), r.centerY())) continue
            val got = byChars(n, text.toString(), r, covered)
            if (got != null) {
                out.addAll(got)
                continue
            }
            // 读不到逐字位置：单行的短文字就用整个节点的框，多行的算作读不到
            if ('\n' !in text && r.height() < 56 * density) out.add(Line(text.toString().trim(), RectF(r)))
            else unknown++
        }
        return unknown
    }

    /** 用每个字的位置把节点文字拆成行；应用不提供时返回 null */
    private fun byChars(n: AccessibilityNodeInfo, text: String, visible: Rect, covered: Region): List<Line>? {
        val key = AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY
        if (key !in n.availableExtraData) return null
        val len = min(text.length, MAX_CHARS)
        val args = Bundle().apply {
            putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_START_INDEX, 0)
            putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_LENGTH, len)
        }
        if (!n.refreshWithExtraData(key, args)) return null
        @Suppress("DEPRECATION")
        val rects = n.extras.getParcelableArray(key) ?: return null
        val lines = ArrayList<Line>()
        val sb = StringBuilder()
        var box: RectF? = null
        fun flush() {
            val b = box
            val t = sb.toString().trim()
            if (b != null && t.isNotEmpty() && !covered.contains(b.centerX().toInt(), b.centerY().toInt())) lines.add(Line(t, b))
            sb.setLength(0)
            box = null
        }
        for (i in 0 until min(len, rects.size)) {
            val c = text[i]
            if (c == '\n') {
                flush()
                continue
            }
            val cr = rects[i] as? RectF
            // 看不见的字（滚出可见范围、被裁掉）：断开
            if (cr == null || cr.isEmpty || !visible.contains(cr.centerX().toInt(), cr.centerY().toInt())) {
                if (c.isWhitespace() && box != null) sb.append(c) else flush()
                continue
            }
            val b = box
            // 换到了下一行（或折回左边）：先收起上一行
            if (b != null && (cr.centerY() > b.bottom || cr.centerY() < b.top || cr.right < b.left)) flush()
            if (box == null) box = RectF(cr) else box!!.union(cr)
            sb.append(c)
        }
        flush()
        return lines
    }
}
