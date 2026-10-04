import { AnimatePresence, motion } from 'motion/react'
import { memo, useMemo } from 'react'
import type { BlockColors, OcrLine, TranslatedBlock } from '@shared/types'
import { familyFor, fitLine, flowText, inkFactor, isCjk, mostlyCjk, MONO, scriptRatio, type Slot } from '../lib/fit'
import './translation-layer.css'

export interface LayerProps {
  lines: OcrLine[]
  blocks: TranslatedBlock[]
  /** 按 OCR 行 id 的视觉样式 */
  colors: Record<number, BlockColors>
  /** 物理像素 / CSS 像素 */
  scale: number
  width: number
  height: number
  targetLang: string
  /** 显示原文（隐藏译文） */
  peek: boolean
  /** 正在等待译文的行 —— 显示扫描骨架 */
  pending: Set<number> | null
  hoverKey?: string | null
  onHover?: (key: string | null) => void
}

const PAD = 2

interface Piece extends Slot {
  text: string
  bg: string
  vertical?: boolean
}

interface Layout {
  key: string
  pieces: Piece[]
  fontSize: number
  fg: string
  family: string
  weight: number
  center: boolean
  align: 'left' | 'center' | 'right'
  wrapped: boolean
  box: Slot
}

export const TranslationLayer = memo(function TranslationLayer(p: LayerProps) {
  const lineMap = useMemo(() => new Map(p.lines.map((l) => [l.id, l])), [p.lines])
  const layouts = useMemo(
    () =>
      p.blocks
        .filter((b) => !b.keep)
        .map((b) => layoutBlock(b, lineMap, p.colors, p.scale, p.width, p.targetLang))
        .filter((l): l is Layout => !!l),
    [p.blocks, lineMap, p.colors, p.scale, p.width, p.targetLang]
  )
  const fade = {
    initial: { opacity: 0 },
    animate: { opacity: p.peek ? 0 : 1 },
    transition: { duration: p.peek ? 0.16 : 0.42, ease: [0.22, 1, 0.36, 1] as const }
  }

  return (
    <div className="tl-layer" style={{ width: p.width, height: p.height }}>
      <AnimatePresence>
        {p.pending &&
          p.lines
            .filter((l) => p.pending!.has(l.id))
            .map((l, i) => (
              <motion.div
                key={`s${l.id}`}
                className="tl-skel"
                style={{ left: l.box.x / p.scale, top: l.box.y / p.scale, width: l.box.w / p.scale, height: l.box.h / p.scale }}
                initial={{ opacity: 0, scaleX: 0.6 }}
                animate={{ opacity: 1, scaleX: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.25 } }}
                transition={{ delay: Math.min(i * 0.018, 0.3), duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              />
            ))}
      </AnimatePresence>

      {/* 先画所有补丁，再画所有文字：相邻块的补丁不会盖住别的块的文字 */}
      {layouts.map((L) => (
        <motion.div key={`pg${L.key}`} className="tl-pgroup" {...fade}>
          {L.pieces.map((q, i) => (
            <div
              key={i}
              className="tl-patch"
              style={{ left: q.x - PAD, top: q.y - PAD, width: q.w + PAD * 2, height: q.h + PAD * 2, background: q.bg, ['--bg' as string]: q.bg }}
            />
          ))}
        </motion.div>
      ))}

      {layouts.map((L) => (
        <motion.div
          key={`tg${L.key}`}
          className={`tl-block${p.hoverKey === L.key ? ' is-hover' : ''}`}
          data-block={L.key}
          onMouseEnter={() => p.onHover?.(L.key)}
          onMouseLeave={() => p.onHover?.(null)}
          style={{ left: L.box.x, top: L.box.y, width: L.box.w, height: L.box.h, color: L.fg, fontFamily: L.family, fontWeight: L.weight, fontSize: L.fontSize }}
          initial={{ opacity: 0, filter: 'blur(6px)' }}
          animate={{ opacity: p.peek ? 0 : 1, filter: p.peek ? 'blur(2px)' : 'blur(0px)' }}
          transition={fade.transition}
        >
          {L.pieces.map((q, i) =>
            q.text ? (
              <div
                key={i}
                className="tl-line"
                style={{
                  left: q.x - L.box.x,
                  top: q.y - L.box.y,
                  width: q.w,
                  height: q.h,
                  lineHeight: L.wrapped ? `${L.fontSize * 1.3}px` : `${q.h}px`,
                  justifyContent: L.align === 'center' ? 'center' : L.align === 'right' ? 'flex-end' : 'flex-start',
                  textAlign: L.align,
                  whiteSpace: L.wrapped ? 'normal' : 'pre',
                  writingMode: q.vertical ? 'vertical-rl' : undefined
                }}
              >
                {q.text}
              </div>
            ) : null
          )}
        </motion.div>
      ))}
    </div>
  )
})

// ------------------------------------------------------------------ 布局
function layoutBlock(
  block: TranslatedBlock,
  lineMap: Map<number, OcrLine>,
  colors: Record<number, BlockColors>,
  scale: number,
  layerW: number,
  targetLang: string
): Layout | null {
  const ls = block.lineIds
    .map((id) => lineMap.get(id))
    .filter((l): l is OcrLine => !!l)
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
  if (!ls.length || ls.some((l) => !colors[l.id])) return null
  const sts = ls.map((l) => colors[l.id])
  const fg = majority(sts.map((c) => c.fg))
  const bold = sts.filter((c) => c.bold).length * 2 > sts.length
  const family = block.role === 'code' ? MONO : familyFor(targetLang)
  const cjk = isCjk(targetLang)
  const srcCjk = mostlyCjk(block.source || ls.map((l) => l.text).join(''))
  const single = ls.length === 1
  const geo = ls.map((l) => slotOf(l, single ? block.source : null, scale))
  const slots = geo.map((g) => g.slot)
  // 原文字号：各行由笔画高度估计，取中位数
  const srcFs = median(ls.map((l, i) => lineFontSize(l, colors[l.id], geo[i], scale)))
  const base = Math.max(8, srcFs * scriptRatio(srcCjk, cjk))
  // 大字号的方块字用粗体会显得过重
  const weight = bold ? (cjk && base > 26 ? 500 : 600) : 400
  const minFs = Math.min(base, Math.max(9, base * 0.62))
  let pieces: Piece[]
  let fontSize: number
  let center = false
  let align: Layout['align'] = 'left'
  let wrapped = false

  if (single && ls[0].vertical && cjk) {
    // 竖排原文 → 竖排译文
    const sl = slots[0]
    fontSize = Math.min(sl.w * 0.72, sl.h / Math.max(1, block.translation.length))
    pieces = [{ ...sl, text: block.translation, bg: sts[0].bg, vertical: true }]
  } else if (single) {
    const sl = slots[0]
    const st = sts[0]
    const g = geo[0]
    center = st.center
    // 可以向两侧空白扩展（被裁掉图标的一侧没有空白），并与相邻元素留出半个字的间距
    const gap = base * 0.5
    const freeR = g.cutR ? 0 : Math.max(0, st.freeR / scale - gap)
    const freeL = g.cutL ? 0 : Math.max(0, st.freeL / scale - gap)
    const right = st.right && !g.cutR
    align = center ? 'center' : right ? 'right' : 'left'
    const avail = center
      ? sl.w + 2 * Math.min(freeL, freeR)
      : right
        ? sl.w + Math.min(freeL, sl.x)
        : sl.w + Math.min(freeR, Math.max(0, layerW - sl.x - sl.w))
    const fit = fitLine(block.translation, sl.w, avail, base, minFs, family, weight)
    fontSize = fit.fontSize
    const x = center ? sl.x + sl.w / 2 - fit.width / 2 : right ? sl.x + sl.w - fit.width : sl.x
    pieces = [{ x: Math.max(0, x), y: sl.y, w: fit.width, h: sl.h, text: block.translation, bg: st.bg }]
  } else {
    // 多行：译文依次流入原文各行的位置
    const flow = flowText(block.translation, slots, family, weight, base, minFs)
    fontSize = flow.fontSize
    const centers = slots.map((sl) => sl.x + sl.w / 2)
    const lefts = slots.map((sl) => sl.x)
    const rights = slots.map((sl) => sl.x + sl.w)
    center = spread(centers) < 6 && spread(lefts) > 12
    align = center ? 'center' : spread(rights) < 4 && spread(lefts) > 12 ? 'right' : 'left'
    const all = [...slots, ...flow.extra]
    pieces = all.map((sl, i) => ({ ...sl, text: flow.lines[i] ?? '', bg: sts[Math.min(i, sts.length - 1)].bg }))
    wrapped = false
  }

  const x0 = Math.min(...pieces.map((q) => q.x))
  const y0 = Math.min(...pieces.map((q) => q.y))
  const x1 = Math.max(...pieces.map((q) => q.x + q.w))
  const y1 = Math.max(...pieces.map((q) => q.y + q.h))
  return { key: block.key, pieces, fontSize, fg, family, weight, center, align, wrapped, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
}

// ------------------------------------------------------------------ 槽位
interface Geo {
  slot: Slot
  /** 框内文字实际横向范围（物理像素，相对框左边） */
  lx0: number
  lx1: number
  /** 文字对应的 OCR 字符下标范围 */
  a: number
  b: number
  cutL: boolean
  cutR: boolean
}

/**
 * 一行原文实际被文字占据的横向范围。OCR 框常把行首/行尾的图标也框进去：
 *  1. 模型给出的原文（src）里没有、而 OCR 文本首尾多出的 1~4 个字符（▲ ☆ <> 等被认成文字的图标、列表序号）裁掉；
 *  2. 第一个/最后一个字符离框边很远（没被识别成字符的图标）也裁掉。
 * 这样补丁只盖住文字，图标保留可见。
 */
function slotOf(l: OcrLine, src: string | null, scale: number): Geo {
  const { box, cx } = l
  let x0 = 0
  let x1 = box.w
  let a = 0
  let b = Math.max(0, [...l.text].length - 1)
  if (cx && cx.length >= 2 && l.score >= 0.6) {
    const gaps = cx
      .slice(1)
      .map((v, i) => v - cx[i])
      .sort((p, q) => p - q)
    const step = gaps[Math.floor(gaps.length / 2)]
    const chars = [...l.text]
    // 方块字等宽，半字宽 ≈ 0.5 个字距；拉丁字母宽窄不一，取 0.62
    const halfOf = (c: string | undefined) => Math.min(box.h * 0.6, Math.max(box.h * 0.22, step * (c && c.charCodeAt(0) > 0x2e7f ? 0.52 : 0.62)))
    ;[a, b] = src ? trimJunk(l.text, src) : [0, cx.length - 1]
    let left = cx[a] - halfOf(chars[a]) - 2
    let right = cx[b] + halfOf(chars[b]) + 2
    // 被裁掉的图标紧挨着文字时，只裁到两者中点，避免补丁盖住半个图标
    if (a > 0) left = Math.max(left, (cx[a - 1] + cx[a]) / 2)
    if (b < cx.length - 1) right = Math.min(right, (cx[b] + cx[b + 1]) / 2)
    if (left > box.h * 0.3) x0 = left
    if (box.w - right > box.h * 0.3) x1 = right
  }
  return {
    slot: { x: (box.x + x0) / scale, y: box.y / scale, w: (x1 - x0) / scale, h: box.h / scale },
    lx0: x0,
    lx1: x1,
    a,
    b,
    cutL: x0 > 0,
    cutR: x1 < box.w
  }
}

/** 由笔画实际高度估计原文字号（CSS 像素）；拿不到笔画信息时退回按框高估计 */
function lineFontSize(l: OcrLine, st: BlockColors, g: Geo, scale: number) {
  const boxFs = Math.max(6, (l.box.h - 3.5) / 1.03)
  let top = Infinity
  let bot = -Infinity
  let cols = 0
  const from = Math.max(0, Math.floor(g.lx0))
  const to = Math.min(st.inkTop.length - 1, Math.ceil(g.lx1))
  for (let x = from; x <= to; x++) {
    if (st.inkTop[x] < 0) continue
    cols++
    if (st.inkTop[x] < top) top = st.inkTop[x]
    if (st.inkBot[x] > bot) bot = st.inkBot[x]
  }
  if (cols < 3 || l.score < 0.5) return boxFs / scale
  const text = [...l.text].slice(g.a, g.b + 1).join('') || l.text
  const inkFs = (bot - top + 1) / inkFactor(text)
  return Math.min(boxFs * 1.2, Math.max(boxFs * 0.6, inkFs)) / scale
}

/** 返回 OCR 文本中真正属于原文的字符下标范围 [a, b] */
function trimJunk(ocr: string, src: string): [number, number] {
  const chars = [...ocr]
  const m = [...src.replace(/\s+/g, ' ').trim()]
  if (m.length < 2 || chars.length < 2) return [0, chars.length - 1]
  const joined = chars.join('')
  let a = 0
  let b = chars.length - 1
  const head = m.slice(0, Math.min(3, m.length)).join('')
  const ia = joined.indexOf(head)
  if (ia > 0) {
    const junk = [...joined.slice(0, ia)]
    if (junk.filter((c) => c.trim()).length <= 4) a = junk.length
  }
  const tail = m.slice(-Math.min(3, m.length)).join('')
  const ib = joined.lastIndexOf(tail)
  if (ib >= 0) {
    const end = [...joined.slice(0, ib + tail.length)].length
    const junk = chars.slice(end)
    if (end - 1 > a && junk.filter((c) => c.trim()).length <= 4) b = end - 1
  }
  return [a, b]
}

function majority(xs: string[]) {
  const n = new Map<string, number>()
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

function spread(a: number[]) {
  return Math.max(...a) - Math.min(...a)
}
