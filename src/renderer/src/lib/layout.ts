import type { BlockColors, OcrLine, TranslatedBlock } from '@shared/types'
import { breakLines, familyFor, fontOf, inkFactor, isCjk, longUnit, measure, mostlyCjk, MONO, scriptRatio, tokenize, type Slot } from './fit'

export const PATCH_PAD = 2

/** emoji（含肤色、组合序列）；© ® ™ 这类默认按文字显示的符号不算 */
const EMOJI = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F?))*/gu

interface Piece extends Slot {
  text: string
  bg: string
  vertical?: boolean
}

export interface Layout {
  key: string
  pieces: Piece[]
  patches: Piece[]
  truncated: boolean
  fullText: string
  fontSize: number
  fg: string
  family: string
  weight: number
  align: 'left' | 'center' | 'right'
  box: Slot
}

/** 按流式到达顺序占位，后到的译文既避让所有原文，也避让已经排好的译文。 */
export function layoutBlocks(
  blocks: TranslatedBlock[], lines: OcrLine[], colors: Record<number, BlockColors>,
  scale: number, width: number, height: number, targetLang: string
): Layout[] {
  if (!(scale > 0 && width > 0 && height > 0)) return []
  const lineMap = new Map(lines.map((l) => [l.id, l]))
  const layouts: Layout[] = []
  const occupied: Slot[] = []
  for (const block of blocks) {
    if (block.keep) continue
    const layout = layoutBlock(block, lineMap, lines, colors, scale, width, height, targetLang, occupied)
    if (!layout) continue
    layouts.push(layout)
    // 补丁始终在文字下层；只为字占位，避免反复叠加补丁留白，把相邻段落无故挤开。
    occupied.push(...layout.pieces.filter((p) => p.text))
  }
  return layouts
}

const overlaps = (a: Slot, b: Slot) => a.x < b.x + b.w - 1e-6 && a.x + a.w > b.x + 1e-6 && a.y < b.y + b.h - 1e-6 && a.y + a.h > b.y + 1e-6
const grow = (a: Slot, pad: number): Slot => ({ x: a.x - pad, y: a.y - pad, w: a.w + pad * 2, h: a.h + pad * 2 })

/** 遮盖原文的补丁也必须避让邻居；OCR 框有少量重叠时，不能把小字一起涂掉。 */
function subtract(rect: Slot, blocker: Slot): Slot[] {
  if (!overlaps(rect, blocker)) return [rect]
  const l = Math.max(rect.x, blocker.x), r = Math.min(rect.x + rect.w, blocker.x + blocker.w)
  const t = Math.max(rect.y, blocker.y), b = Math.min(rect.y + rect.h, blocker.y + blocker.h)
  return [
    { x: rect.x, y: rect.y, w: rect.w, h: t - rect.y },
    { x: rect.x, y: b, w: rect.w, h: rect.y + rect.h - b },
    { x: rect.x, y: t, w: l - rect.x, h: b - t },
    { x: r, y: t, w: rect.x + rect.w - r, h: b - t }
  ].filter((p) => p.w > 0 && p.h > 0)
}

// ------------------------------------------------------------------ 布局
// 译文先按原文的行"槽位"排；放不下时像浏览器那样在段落范围内重新折行（行距随字号等比缩放），
// 仍放不下再借用段落下方到下一行文字之间的空白；都不行才继续缩小字号。译文行之间、与其它文字之间都不重叠。

interface Row {
  slots: { s: Slot; bg: string }[]
  x: number
  r: number
  y: number
  h: number
  cy: number
  bg: string
  /** 译文行可以占用的横向范围（含两侧空白） */
  lo: number
  hi: number
}

interface Fit {
  fontSize: number
  pieces: Piece[]
  truncated?: boolean
}

function layoutBlock(
  block: TranslatedBlock,
  lineMap: Map<number, OcrLine>,
  allLines: OcrLine[],
  colors: Record<number, BlockColors>,
  scale: number,
  layerW: number,
  layerH: number,
  targetLang: string,
  occupied: Slot[]
): Layout | null {
  const own = block.lineIds
    .map((id) => lineMap.get(id))
    .filter((l): l is OcrLine => !!l)
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
  if (!own.length || own.some((l) => !colors[l.id])) return null
  // 行首的列表符号、序号、图标（① • □ 1.）被单独识别成一行时保留原样，不盖住也不往里排字
  const marks = findMarkers(own)
  const ls = own.filter((l) => !marks.has(l))
  if (!ls.length) return null
  // OCR 一般认不出 emoji，原图里的 emoji 会保留可见；译文里再画一遍就重复了（OCR 认出来的才会被盖住，那些保留）
  const ocrText = own.map((l) => l.text).join('')
  let text = block.translation.replace(EMOJI, (e) => (ocrText.includes(e) ? e : '')).replace(/[ \t]{2,}/g, ' ').trim()
  for (const m of [...marks].sort((a, b) => a.box.x - b.box.x)) {
    const t = m.text.replace(/\s/g, '')
    const s = text.trimStart()
    if (s.startsWith(t)) text = s.slice(t.length).trimStart()
  }
  if (!text) return null

  const sts = ls.map((l) => colors[l.id])
  const fg = majority(sts.map((c) => c.fg))
  const bold = sts.filter((c) => c.bold).length * 2 > sts.length
  const family = block.role === 'code' ? MONO : familyFor(targetLang)
  const cjk = isCjk(targetLang)
  const srcCjk = mostlyCjk(block.source || ls.map((l) => l.text).join(''))
  const single = ls.length === 1
  const geo = ls.map((l) => slotOf(l, single ? block.source : null, scale))
  const ownIds = new Set(ls.map((l) => l.id))
  const blockers: Slot[] = allLines.filter((l) => !ownIds.has(l.id)).map((l) => ({
    x: l.box.x / scale, y: l.box.y / scale, w: l.box.w / scale, h: l.box.h / scale
  }))
  blockers.push(...occupied)
  // 保留 OCR 框中被裁掉的图标（如按钮左图标、右侧下拉箭头）。
  geo.forEach((g, i) => {
    const b = ls[i].box
    if (g.cutL) blockers.push({ x: b.x / scale, y: b.y / scale, w: g.lx0 / scale, h: b.h / scale })
    if (g.cutR) blockers.push({ x: (b.x + g.lx1) / scale, y: b.y / scale, w: (b.w - g.lx1) / scale, h: b.h / scale })
  })
  const guards = blockers.map((b) => grow(b, PATCH_PAD + 1))
  const valid = (fit: Fit | null): Fit | null => {
    if (!fit) return null
    const ps = fit.pieces.filter((p) => p.text)
    for (const [i, p] of ps.entries()) {
      if (p.x < 0 || p.y < 0 || p.x + p.w > layerW + 0.01 || p.y + p.h > layerH + 0.01 ||
        guards.some((g) => overlaps(p, g)) || ps.slice(0, i).some((q) => overlaps(p, q))) return null
    }
    return ps.length ? fit : null
  }
  // 原文字号：各行由笔画高度估计，取中位数
  const srcFs = median(ls.map((l, i) => lineFontSize(l, colors[l.id], geo[i], scale)))
  const base = Math.max(8, srcFs * scriptRatio(srcCjk, cjk))
  // 大字号的方块字用粗体会显得过重
  const weight = bold ? (cjk && base > 26 ? 500 : 600) : 400
  const done = (fit: Fit, align: Layout['align']): Layout => {
    const ps = fit.pieces
    const patches = ps.flatMap((p) => {
      const r = grow(p, PATCH_PAD)
      const clipped = { x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(layerW, r.x + r.w) - Math.max(0, r.x), h: Math.min(layerH, r.y + r.h) - Math.max(0, r.y) }
      return blockers.reduce<Slot[]>((parts, b) => parts.flatMap((q) => subtract(q, grow(b, 1))), [clipped])
        .filter((q) => q.w > 0 && q.h > 0).map((q) => ({ ...q, text: '', bg: p.bg }))
    })
    const x0 = Math.min(...ps.map((q) => q.x))
    const y0 = Math.min(...ps.map((q) => q.y))
    const x1 = Math.max(...ps.map((q) => q.x + q.w))
    const y1 = Math.max(...ps.map((q) => q.y + q.h))
    return { key: block.key, pieces: ps, patches, truncated: !!fit.truncated, fullText: block.translation, fontSize: fit.fontSize, fg, family, weight, align, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
  }

  if (single && ls[0].vertical && cjk) {
    // 竖排原文 → 竖排译文
    const sl = geo[0].slot
    const fontSize = Math.min(sl.w * 0.72, sl.h / Math.max(1, text.length))
    const fit = valid({ fontSize, pieces: [{ ...sl, text, bg: sts[0].bg, vertical: true }] })
    if (fit) return done(fit, 'left')
  }

  // 在整条行高内检查 OCR 框，不能只依赖几条水平像素探针（会漏掉旁边的小字）。
  const safeRange = (lo: number, hi: number, top: number, h: number, anchor: Slot) => {
    let spans = [{ lo: Math.max(0, lo), hi: Math.min(layerW, hi) }]
    for (const b of guards) {
      if (b.y >= top + h || b.y + b.h <= top) continue
      spans = spans.flatMap((s) => b.x >= s.hi || b.x + b.w <= s.lo ? [s] : [
        { lo: s.lo, hi: Math.min(s.hi, b.x) }, { lo: Math.max(s.lo, b.x + b.w), hi: s.hi }
      ]).filter((s) => s.hi > s.lo)
    }
    // 保持原文所在的栏；不跳过障碍物跑到另一栏。
    const ranked = spans.map((s) => ({ ...s, overlap: Math.min(s.hi, anchor.x + anchor.w) - Math.max(s.lo, anchor.x) }))
      .filter((s) => s.overlap > 0).sort((a, b) => b.overlap - a.overlap)
    return ranked[0] ?? { lo: Math.max(0, anchor.x), hi: Math.max(0, anchor.x) }
  }

  // ---- 行：纵向重叠的槽位属于同一行（同一行里的多个框按从左到右的顺序排字）
  const items = ls.map((l, i) => ({ s: geo[i].slot, g: geo[i], st: sts[i], box: l.box }))
  const groups: (typeof items)[] = []
  for (const it of [...items].sort((a, b) => a.s.y + a.s.h / 2 - (b.s.y + b.s.h / 2))) {
    const row = groups[groups.length - 1]
    if (row) {
      const top = Math.min(...row.map((o) => o.s.y))
      const bot = Math.max(...row.map((o) => o.s.y + o.s.h))
      const ov = Math.min(bot, it.s.y + it.s.h) - Math.max(top, it.s.y)
      if (ov >= Math.min(it.s.h, bot - top) * 0.5) {
        row.push(it)
        continue
      }
    }
    groups.push([it])
  }
  for (const g of groups) g.sort((a, b) => a.s.x - b.s.x)

  // ---- 对齐方式
  let align: Layout['align'] = 'left'
  if (groups.length === 1 && groups[0].length === 1) {
    const { g, st } = groups[0][0]
    align = st.center ? 'center' : st.right && !g.cutR ? 'right' : 'left'
  } else if (groups.length > 1) {
    const lefts = groups.map((g) => g[0].s.x)
    const rights = groups.map((g) => g[g.length - 1].s.x + g[g.length - 1].s.w)
    const centers = lefts.map((l, i) => (l + rights[i]) / 2)
    align = spread(centers) < 6 && spread(lefts) > 12 ? 'center' : spread(rights) < 4 && spread(lefts) > 12 ? 'right' : 'left'
  }

  // ---- 每行可用的横向范围：可以向空白一侧扩展（被裁掉图标的一侧没有空白），并与相邻元素留出半个字的间距
  const gap = base * 0.5
  const rows: Row[] = groups.map((g) => {
    const L = g[0]
    const R = g[g.length - 1]
    const x = L.s.x
    const r = R.s.x + R.s.w
    const y = Math.min(...g.map((o) => o.s.y))
    const h = Math.max(...g.map((o) => o.s.y + o.s.h)) - y
    const fl = L.g.cutL ? 0 : Math.max(0, L.st.freeL / scale - gap)
    const fr = R.g.cutR ? 0 : Math.max(0, R.st.freeR / scale - gap)
    let lo = x
    let hi = r
    if (align === 'center') {
      const e = Math.min(fl, fr)
      lo = x - e
      hi = r + e
    } else if (align === 'right') lo = x - Math.min(fl, x)
    else hi = r + Math.min(fr, Math.max(0, layerW - r))
    ;({ lo, hi } = safeRange(lo, hi, y, h, { x, y, w: r - x, h }))
    const bg = majority(g.map((o) => o.st.bg))
    return { slots: g.map((o) => ({ s: o.s, bg: o.st.bg })), x, r, y, h, cy: y + h / 2, bg, lo, hi }
  })
  const flat = rows.flatMap((r) => r.slots)
  const units = tokenize(text.replace(/\s*\n\s*/g, ' '))
  const place = (lo: number, hi: number, tw: number) => (align === 'center' ? (lo + hi) / 2 - tw / 2 : align === 'right' ? hi - tw : lo)

  // ---- 方案一：排进原文各行的位置（只有一个槽位时可以向两侧空白延伸）
  const inSlots = (fs: number): Fit | null => {
    const font = fontOf(weight, fs, family)
    if (flat.length === 1) {
      const row = rows[0]
      const sl = flat[0].s
      const h = Math.max(sl.h, fs * 1.2)
      const y = sl.y + (sl.h - h) / 2
      const { lo, hi } = safeRange(row.lo, row.hi, y, h, sl)
      const lines = breakLines(units, font, () => hi - lo, 1, () => 'fail')
      if (!lines) return null
      const w = measure(font, lines[0])
      const x = align === 'center' ? sl.x + sl.w / 2 - w / 2 : align === 'right' ? sl.x + sl.w - w : sl.x
      return valid({ fontSize: fs, pieces: [
        { ...sl, text: '', bg: flat[0].bg },
        { x: Math.max(lo, Math.min(hi - w, x)), y, w, h, text: lines[0], bg: flat[0].bg }
      ] })
    }
    const maxW = Math.max(...flat.map((f) => f.s.w))
    const lines = breakLines(units, font, (k) => flat[k].s.w, flat.length, (u) => (measure(font, u.trimEnd()) > maxW ? 'break' : 'skip'))
    if (!lines) return null
    return valid({ fontSize: fs, pieces: flat.map((f, k) => {
      const h = Math.max(f.s.h, fs * 1.2)
      return { ...f.s, y: f.s.y + (f.s.h - h) / 2, h, text: lines[k] ?? '', bg: f.bg }
    }) })
  }

  // ---- 方案二：在段落范围内重新折行
  const h0 = median(rows.map((r) => r.h))
  const deltas = rows.slice(1).map((r, i) => r.cy - rows[i].cy)
  const pitch = Math.max(h0, deltas.length ? median(deltas) : Math.max(h0 * 1.15, base * 1.35))
  const last = rows[rows.length - 1]
  const ownBottom = last.y + last.h + h0 * 0.15
  // 段落下方的空白：直到下一行（横向有重叠的）文字为止
  const spanL = Math.min(...rows.map((r) => r.lo))
  const spanR = Math.max(...rows.map((r) => r.hi))
  let extBottom = layerH
  for (const b of guards) {
    if (b.x >= spanR || b.x + b.w <= spanL || b.y < last.y + last.h) continue
    extBottom = Math.min(extBottom, b.y)
  }
  // 各译文行的范围：对齐的那一侧跟随它压着的原文行（首行缩进），另一侧取所有行的交集，
  // 避免段落末行的大片空白把某一行拉得特别长；段落下方的行按除首行外的各行处理
  const capLo = Math.max(...rows.map((r) => r.lo))
  const capHi = Math.min(...rows.map((r) => r.hi))
  const rest = rows.length > 1 ? rows.slice(1) : rows
  const rangeAt = (top: number, lh: number) => {
    const hits = rows.map((r) => ({ r, ov: Math.min(top + lh, r.y + r.h) - Math.max(top, r.y) })).filter((o) => o.ov > 0)
    const best = hits.length ? hits.reduce((p, q) => (q.ov > p.ov ? q : p)).r : last
    const over = hits.length ? hits.filter((o) => o.ov > lh * 0.25).map((o) => o.r).concat(best) : rest
    let lo = align === 'left' ? Math.max(...over.map((r) => r.lo)) : capLo
    let hi = align === 'right' ? Math.min(...over.map((r) => r.hi)) : capHi
    if (hi - lo < (best.hi - best.lo) * 0.5) {
      lo = best.lo
      hi = best.hi
    }
    return { ...safeRange(lo, hi, top, lh, { x: best.x, y: best.y, w: best.r - best.x, h: best.h }), bg: best.bg }
  }
  // 所有重排都有下边界；空间不足时显示省略号，完整译文仍保存在 block 中。
  const reflow = (fs: number, bottom: number, emergency = false, truncate = false): Fit | null => {
    const font = fontOf(weight, fs, family)
    const k = fs / base
    const lh = Math.max(fs * 1.2, h0 * k)
    const lead = Math.max(lh, pitch * k)
    // 缩小字号后从原行顶部开始重排，利用原框内腾出的高度，避免把第一行仍居中而挤到下一段。
    const top0 = Math.max(0, Math.min(rows[0].y, rows[0].cy - lh / 2))
    let maxLines = Math.floor((Math.min(layerH, bottom) - top0 - lh) / lead + 1e-6) + 1
    if (maxLines < 1) return null
    const ranges: ReturnType<typeof rangeAt>[] = []
    const range = (i: number) => (ranges[i] ??= rangeAt(top0 + i * lead, lh))
    // 某行被邻居完全挡住时就在它上方停止，不跨过别的段落接着排。
    for (let i = 0; i < maxLines; i++) {
      if (range(i).hi <= range(i).lo) { maxLines = i; break }
    }
    if (maxLines < 1) return null
    const lines = truncate ? ellipsize(text, font, (i) => range(i).hi - range(i).lo, maxLines) : breakLines(units, font, (i) => range(i).hi - range(i).lo, maxLines, (u) =>
      longUnit(u) ? 'break' : emergency ? 'hyphen' : 'fail'
    )
    if (!lines) return null
    const covers: Piece[] = flat.map((f) => ({ ...f.s, text: '', bg: f.bg }))
    const out: Piece[] = lines.map((t, i) => {
      const { lo, hi, bg } = range(i)
      const tw = measure(font, t)
      return { x: Math.max(0, place(lo, hi, tw)), y: top0 + i * lead, w: tw, h: lh, text: t, bg }
    })
    return valid({ fontSize: fs, pieces: [...covers, ...out.filter((q) => q.text)], truncated: truncate })
  }

  // ---- 从原字号开始逐步缩小，每个字号依次尝试：原位 → 段落内重排 → 借用下方空白
  // 单行的界面文字（按钮、标签）宁可缩小也不折行
  const multi = rows.length > 1
  const wrapOk = multi || !(block.role === 'ui' || block.role === 'code') || units.length > 8
  const borrowAt = multi ? 0.86 : 0.76
  const floor = Math.min(base, Math.max(8, base * 0.5))
  const sizes: number[] = []
  for (let fs = base; fs > floor; fs *= 0.95) sizes.push(fs)
  sizes.push(floor)
  for (const fs of sizes) {
    const fit = inSlots(fs) ?? (wrapOk ? reflow(fs, Math.min(ownBottom, extBottom)) : null) ?? (wrapOk && fs <= base * borrowAt ? reflow(fs, extBottom) : null)
    if (fit) return done(fit, align)
  }
  // 取消无限向下/横向溢出的兜底，也不再为了放下译文盖住图标。
  const fit = reflow(floor, extBottom, true) ?? reflow(floor, extBottom, true, true)
  return fit ? done(fit, align) : null
}

/** 仅在完整译文怎么排都放不下时使用；按字素截断，不切开 emoji/组合字符。 */
function ellipsize(text: string, font: string, width: (k: number) => number, maxLines: number) {
  const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment)
  let lo = 0, hi = chars.length
  let best = breakLines(['…'], font, width, maxLines)
  while (lo <= hi) {
    const n = (lo + hi) >> 1
    const lines = breakLines(tokenize(chars.slice(0, n).join('').trimEnd() + '…'), font, width, maxLines)
    if (lines) { best = lines; lo = n + 1 } else hi = n - 1
  }
  return best
}

/** 行首被单独识别出来的列表符号 / 序号 / 图标：1~2 个非文字字符，右侧同一行有更长的文字 */
function findMarkers(ls: OcrLine[]) {
  const out = new Set<OcrLine>()
  for (const m of ls) {
    const t = m.text.replace(/\s/g, '')
    if (!t || [...t].length > 2 || /\p{L}/u.test(t) || m.box.w > m.box.h * 1.8) continue
    const host = ls.some(
      (o) =>
        o !== m &&
        !out.has(o) &&
        o.box.x >= m.box.x + m.box.w * 0.5 &&
        o.box.w > m.box.w * 2 &&
        Math.min(o.box.y + o.box.h, m.box.y + m.box.h) - Math.max(o.box.y, m.box.y) >= Math.min(o.box.h, m.box.h) * 0.5
    )
    if (host) out.add(m)
  }
  return out
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
