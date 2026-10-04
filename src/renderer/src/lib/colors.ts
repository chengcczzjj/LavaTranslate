// 从截图像素中分析一行原文的视觉样式：背景色、文字色、粗细、对齐、两侧空白、笔画上下边界
import type { BlockColors, Rect } from '@shared/types'

interface Bucket {
  n: number
  r: number
  g: number
  b: number
}

function key(r: number, g: number, b: number) {
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
}

function top(map: Map<number, Bucket>): Bucket | null {
  let best: Bucket | null = null
  for (const v of map.values()) if (!best || v.n > best.n) best = v
  return best
}

function add(map: Map<number, Bucket>, r: number, g: number, b: number) {
  const k = key(r, g, b)
  const v = map.get(k)
  if (v) {
    v.n++
    v.r += r
    v.g += g
    v.b += b
  } else map.set(k, { n: 1, r, g, b })
}

function sum(m: Map<number, Bucket>) {
  let s = 0
  for (const v of m.values()) s += v.n
  return s
}

function dist(a: number[], r: number, g: number, b: number) {
  const dr = a[0] - r
  const dg = a[1] - g
  const db = a[2] - b
  return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) * 1.7
}

function lum([r, g, b]: number[]) {
  const f = (c: number) => {
    c /= 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrast(a: number[], b: number[]) {
  const la = lum(a)
  const lb = lum(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const hex = (c: number[]) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')

/**
 * 文字色。不能用众数或整体平均：ClearType 次像素抗锯齿时 R/G/B 三个子像素各有各的覆盖率，
 * 小字号笔画边缘带蓝/橙色边，数量往往比笔画中心还多。但每个通道在其"完全覆盖"的像素上
 * 取到的正好是文字色 —— 所以逐通道取极值方向的分位数。
 */
function inkColor(px: Uint8Array, ink: number[], bg: number[]): number[] {
  return [0, 1, 2].map((c) => {
    const v = ink.map((i) => px[i + c]).sort((a, b) => a - b)
    const mean = v.reduce((s, x) => s + x, 0) / v.length
    return v[Math.round((v.length - 1) * (mean < bg[c] ? 0.06 : 0.94))]
  })
}

const FREE_CAP = 1600

/**
 * @param px 整屏 RGBA 像素
 * @param W  整屏宽（物理像素）
 * @param r  一行文字的 OCR 框（物理像素，整屏坐标）
 * @param lineH 行高（物理像素）
 */
export function sampleColors(px: Uint8Array, W: number, H: number, r: Rect, lineH: number): BlockColors {
  const x0 = Math.max(0, Math.floor(r.x))
  const y0 = Math.max(0, Math.floor(r.y))
  const x1 = Math.min(W - 1, Math.ceil(r.x + r.w) - 1)
  const y1 = Math.min(H - 1, Math.ceil(r.y + r.h) - 1)
  const bw = x1 - x0 + 1
  const bh = y1 - y0 + 1

  // ---- 背景：框外 1~3px 一圈像素的众数；若外圈被别的元素占据而框内主色更显著，用框内主色
  const ring = new Map<number, Bucket>()
  const at = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const i = (y * W + x) * 4
    add(ring, px[i], px[i + 1], px[i + 2])
  }
  for (let t = 1; t <= 3; t++) {
    for (let x = x0 - t; x <= x1 + t; x++) {
      at(x, y0 - t)
      at(x, y1 + t)
    }
    for (let y = y0 - t; y <= y1 + t; y++) {
      at(x0 - t, y)
      at(x1 + t, y)
    }
  }
  const inner = new Map<number, Bucket>()
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4
      add(inner, px[i], px[i + 1], px[i + 2])
    }
  }
  const rb = top(ring)
  const ib = top(inner)!
  let bgB = rb ?? ib
  if (rb && ib.n / Math.max(1, sum(inner)) > 0.45 && rb.n / Math.max(1, sum(ring)) < 0.35) bgB = ib
  const bg = [bgB.r / bgB.n, bgB.g / bgB.n, bgB.b / bgB.n]

  // ---- 文字色：按横向分段各自取色，再取墨迹最多的那一类（行内夹着彩色链接时以正文颜色为准）
  const segW = Math.max(24, Math.round(lineH * 2.5))
  const segs: { ink: number[]; color: number[] }[] = []
  for (let sx = x0; sx <= x1; sx += segW) {
    const ink: number[] = []
    for (let y = y0; y <= y1; y++) {
      for (let x = sx; x < Math.min(x1 + 1, sx + segW); x++) {
        const i = (y * W + x) * 4
        if (dist(bg, px[i], px[i + 1], px[i + 2]) > 60) ink.push(i)
      }
    }
    if (ink.length >= 6) segs.push({ ink, color: inkColor(px, ink, bg) })
  }
  let fg: number[]
  if (segs.length) {
    const groups: { segs: typeof segs; n: number }[] = []
    for (const s of segs) {
      const g = groups.find((g) => dist(g.segs[0].color, s.color[0], s.color[1], s.color[2]) < 45)
      if (g) {
        g.segs.push(s)
        g.n += s.ink.length
      } else groups.push({ segs: [s], n: s.ink.length })
    }
    const best = groups.sort((a, b) => b.n - a.n)[0]
    fg = inkColor(
      px,
      best.segs.flatMap((s) => s.ink),
      bg
    )
  } else fg = lum(bg) > 0.4 ? [24, 24, 28] : [240, 240, 244]
  if (contrast(fg, bg) < 2.2) fg = lum(bg) > 0.4 ? [24, 24, 28] : [245, 245, 248]

  // ---- 笔画：只认与背景差异足够大的"笔画中心"像素，避免 ClearType 彩边把细字算粗
  const fgD = dist(bg, fg[0], fg[1], fg[2])
  const thrCore = Math.max(40, fgD * 0.62)
  const thrInk = Math.max(36, fgD * 0.45)
  const isInk = (x: number, y: number, thr: number) => {
    const i = (y * W + x) * 4
    return dist(bg, px[i], px[i + 1], px[i + 2]) > thr
  }

  // 笔画所在的连续行带：取墨迹总量最大的一段连续非空行（行距处为空行），
  // 排除上下相邻行的笔画，也避免被下划线这类"单行很满"的元素带偏
  const rows = new Array<number>(bh).fill(0)
  for (let y = 0; y < bh; y++) for (let x = x0; x <= x1; x++) if (isInk(x, y0 + y, thrInk)) rows[y]++
  let bandT = 0
  let bandB = -1
  let bestSum = 0
  for (let y = 0; y < bh; ) {
    if (!rows[y]) {
      y++
      continue
    }
    let e = y
    let sum = 0
    while (e < bh && rows[e]) sum += rows[e++]
    if (sum > bestSum) {
      bestSum = sum
      bandT = y
      bandB = e - 1
    }
    y = e
  }

  const inkTop = new Array<number>(bw).fill(-1)
  const inkBot = new Array<number>(bw).fill(-1)
  const core = new Uint8Array(bw * bh)
  if (bestSum > 0) {
    for (let x = 0; x < bw; x++) {
      for (let y = bandT; y <= bandB; y++) {
        if (isInk(x0 + x, y0 + y, thrInk)) {
          if (inkTop[x] < 0) inkTop[x] = y
          inkBot[x] = y
        }
        if (isInk(x0 + x, y0 + y, thrCore)) core[y * bw + x] = 1
      }
    }
  }

  // 粗细：每个笔画像素所在的横向/纵向连续段取较短者 ≈ 该处笔画厚度（竖笔看横向、横笔看纵向），取中位数。
  // 不能用横向段平均长度：方块字的横笔很长，会把常规体算成粗体
  const thick: number[] = []
  for (let y = bandT; y <= bandB; y++) {
    for (let x = 0; x < bw; x++) {
      if (!core[y * bw + x]) continue
      let l = x
      while (l > 0 && core[y * bw + l - 1]) l--
      let r = x
      while (r < bw - 1 && core[y * bw + r + 1]) r++
      let t = y
      while (t > bandT && core[(t - 1) * bw + x]) t--
      let b = y
      while (b < bandB && core[(b + 1) * bw + x]) b++
      thick.push(Math.min(r - l + 1, b - t + 1))
    }
  }
  thick.sort((a, b) => a - b)
  const stroke = thick.length ? thick[thick.length >> 1] : 0
  const bandH = Math.max(1, bandB - bandT + 1)
  // 实测（Segoe/Arial/Verdana/雅黑/游ゴシック 多页面）：常规体 ≤ 0.111，粗体 ≥ 0.123；1px 的笔画一律视为常规体
  const bold = stroke >= 2 && stroke / bandH > 0.118

  // ---- 两侧空白：沿笔画带的几条水平线向外走，直到碰到非背景像素
  const probe = [0.25, 0.5, 0.75].map((f) => y0 + Math.round(bandT + (bandB - bandT) * f))
  const free = (dir: -1 | 1) => {
    let x = dir < 0 ? x0 - 1 : x1 + 1
    let n = 0
    while (n < FREE_CAP && x >= 0 && x < W) {
      if (probe.some((y) => isInk(x, y, 30))) break
      x += dir
      n++
    }
    return n
  }
  const freeL = free(-1)
  const freeR = free(1)
  // 居中：两侧都碰到了边界且宽度相当。空白较小（按钮、标签）时允许 30% 误差；
  // 空白很大时（对话框里的居中文字）必须几乎相等，避免把左对齐的文字误判为居中
  const lo = Math.min(freeL, freeR)
  const hi = Math.max(freeL, freeR)
  const center = hi < FREE_CAP && (lo <= lineH * 4 ? hi - lo <= Math.max(5, hi * 0.3) : hi - lo <= Math.max(4, hi * 0.02))

  const right = !center && freeR <= lineH * 1.5 && freeL >= lineH * 2 && freeR < freeL * 0.25

  return { bg: hex(bg), fg: hex(fg), bold, center, right, freeL, freeR, inkTop, inkBot }
}

export function isDark(color: string) {
  const v = parseInt(color.slice(1), 16)
  return lum([(v >> 16) & 255, (v >> 8) & 255, v & 255]) < 0.25
}
