// 译文排版：字号估计、单行适配、多行按原文"行槽位"流式排版。宽度一律用 canvas 测量（快、与 DOM 渲染一致）

// ------------------------------------------------------------------ 字体
const FAMILIES: Record<string, string> = {
  'zh-Hans': '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  'zh-Hant': '"Segoe UI Variable Text", "Segoe UI", "Microsoft JhengHei UI", "Microsoft JhengHei", "PingFang TC", sans-serif',
  ja: '"Segoe UI Variable Text", "Segoe UI", "Yu Gothic UI", "Meiryo UI", "Hiragino Sans", sans-serif',
  ko: '"Segoe UI Variable Text", "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
  default: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif'
}

export const MONO = '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace'

export function familyFor(lang: string) {
  return FAMILIES[lang] ?? FAMILIES.default
}

export function isCjk(lang: string) {
  return lang.startsWith('zh') || lang === 'ja' || lang === 'ko'
}

const CJK_RE = /[぀-ヿ㐀-鿿가-힯豈-﫿＀-￯]/

/** 文本里中日韩字符是否占多数 */
export function mostlyCjk(text: string) {
  const t = [...text.replace(/\s/g, '')]
  if (!t.length) return false
  return t.filter((c) => CJK_RE.test(c)).length / t.length > 0.4
}

// ------------------------------------------------------------------ 测量
let ctx: CanvasRenderingContext2D | null = null
const widthCache = new Map<string, number>()

export function measure(font: string, s: string) {
  const k = font + '\u0000' + s
  let w = widthCache.get(k)
  if (w === undefined) {
    if (!ctx) ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = font
    w = ctx.measureText(s).width
    if (widthCache.size > 20000) widthCache.clear()
    widthCache.set(k, w)
  }
  return w
}

export const fontOf = (weight: number, fs: number, family: string) => `${weight} ${fs}px ${family}`

// ------------------------------------------------------------------ 字号
/**
 * 笔画实际高度占字号的比例，取决于文本里有没有上伸/下伸字母：
 * 方块字 ≈ 0.87em；拉丁 同时有上伸(bdfhklt、大写、数字)和下伸(gjpqy) ≈ 0.95em，只有上伸 ≈ 0.73em，只有下伸 ≈ 0.71em，都没有 ≈ 0.53em（x 高度）
 */
export function inkFactor(text: string) {
  // 方块字本身约 0.87em；全角括号、书名号与拉丁下伸字母会超出方块字的上下范围，合起来约 1em
  if (CJK_RE.test(text)) return /[（）「」『』【】〔〕()[\]{}gjpqy]/.test(text) ? 1.0 : 0.87
  const asc = /[A-Z0-9bdfhiklt'"!?#$%&@/\\|(){}[\]]/.test(text)
  const desc = /[gjpqy(),;{}[\]|@$]/.test(text)
  return asc && desc ? 0.95 : asc ? 0.73 : desc ? 0.71 : 0.53
}

/** 目标文字相对原文字号的视觉补偿：同字号下方块字看起来比拉丁字母大 */
export function scriptRatio(srcCjk: boolean, cjk: boolean) {
  return cjk && !srcCjk ? 0.92 : !cjk && srcCjk ? 1.06 : 1
}

// ------------------------------------------------------------------ 单行
/**
 * 单行译文：先用基准字号；超出槽位时先占用旁边的空白（avail），仍放不下再缩小字号（最低 minFs）。
 * 返回字号与实际宽度（可能大于槽位）。
 */
export function fitLine(text: string, slotW: number, avail: number, base: number, minFs: number, family: string, weight: number) {
  const tw = measure(fontOf(weight, base, family), text)
  let fs = base
  if (tw > avail) fs = Math.max(minFs, (base * avail) / tw)
  return { fontSize: fs, width: Math.max(slotW, (tw * fs) / base) }
}

// ------------------------------------------------------------------ 多行：按原文的行"槽位"流式排版
// 原文每一行是一个槽位（位置、宽度各不相同：绕图、首行缩进、居中段落…），译文依次填进这些槽位，
// 放不下就整体缩小字号；最小字号仍放不下时在最后一行下方追加行。
const NO_START = /^[，。、；：？！）」』”’》〉】〕…—,.;:!?)\]}%·]/
const NO_END = /[（「『“‘《〈【〔([{]$/

/** 切成不可再分的排版单元：方块字逐字、拉丁词整体（带后随空格），并处理避头尾 */
export function tokenize(text: string): string[] {
  const raw = text.match(/[⺀-鿿가-힯豈-﫿＀-￯　-〿]|[^\s⺀-鿿가-힯豈-﫿＀-￯　-〿]+\s*|\s+/g) ?? []
  const out: string[] = []
  for (const u of raw) {
    const prev = out[out.length - 1]
    if (prev !== undefined && (NO_START.test(u) || NO_END.test(prev) || !u.trim())) out[out.length - 1] = prev + u
    else out.push(u)
  }
  return out
}

export interface Slot {
  x: number
  y: number
  w: number
  h: number
}

export interface FlowResult {
  fontSize: number
  /** 与槽位一一对应的文本行（可能比槽位多：溢出追加的行） */
  lines: string[]
  /** 追加的溢出槽位 */
  extra: Slot[]
}

export function flowText(text: string, slots: Slot[], family: string, weight: number, base: number, minFs: number): FlowResult {
  const units = tokenize(text.replace(/\s*\n\s*/g, ' '))
  const last = slots[slots.length - 1]
  const pitch = slots.length > 1 ? (last.y - slots[0].y) / (slots.length - 1) : last.h * 1.25
  const maxW = Math.max(...slots.map((s) => s.w))
  const place = (fs: number, allowExtra: boolean): FlowResult | null => {
    const us = [...units]
    const font = fontOf(weight, fs, family)
    const lines: string[] = []
    const extra: Slot[] = []
    let i = 0
    let si = 0
    while (i < us.length) {
      let slot = slots[si]
      if (!slot) {
        if (!allowExtra) return null
        slot = { x: last.x, y: last.y + pitch * (extra.length + 1), w: maxW, h: last.h }
        extra.push(slot)
      }
      let line = ''
      while (i < us.length) {
        const next = line + us[i]
        if (measure(font, next.trimEnd()) <= slot.w + 0.5) {
          line = next
          i++
        } else if (!line) {
          // 单个单元就比槽位宽（长网址等）：按字符硬断
          let cut = ''
          for (const ch of us[i]) {
            if (measure(font, cut + ch) > slot.w && cut) break
            cut += ch
          }
          line = cut
          us[i] = us[i].slice(cut.length)
          if (!us[i]) i++
          break
        } else break
      }
      lines.push(line.trimEnd())
      si++
    }
    while (lines.length < slots.length) lines.push('')
    return { fontSize: fs, lines, extra }
  }
  // 从基准字号开始逐步缩小，直到放进原有槽位
  for (let fs = base; fs >= minFs; fs *= 0.95) {
    const r = place(fs, false)
    if (r) return r
  }
  return place(minFs, true)!
}
