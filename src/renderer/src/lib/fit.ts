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

// ------------------------------------------------------------------ 折行
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

/** 一个排版单元比当前行还宽时怎么办：按字符硬断 / 拉丁单词加连字符断开 / 空出本行放到下一行 / 放弃这种排法 */
export type Wide = 'break' | 'hyphen' | 'skip' | 'fail'

/** 长网址、路径这类很长的单元：只有它们才允许按字符硬断，普通单词宁可缩小字号 */
export const longUnit = (u: string) => u.trim().length >= 16

/** 把排版单元依次排进各行，第 k 行宽 widthOf(k)，最多 maxLines 行；放不下返回 null */
export function breakLines(
  units: string[],
  font: string,
  widthOf: (k: number) => number,
  maxLines: number,
  wide: (unit: string, k: number) => Wide = () => 'break'
): string[] | null {
  const us = [...units]
  const lines: string[] = []
  let i = 0
  while (i < us.length) {
    const k = lines.length
    if (k >= maxLines) return null
    const w = widthOf(k)
    let line = ''
    while (i < us.length) {
      const next = line + us[i]
      if (measure(font, next.trimEnd()) <= w + 0.5) {
        line = next
        i++
        continue
      }
      if (line) break
      const how = wide(us[i], k)
      if (how === 'fail') return null
      const word = us[i].trimEnd()
      if (how === 'hyphen' && /^[A-Za-zÀ-ɏ]{6,}$/.test(word)) {
        // 两侧各至少留 3 个字母
        let n = 3
        while (n < word.length - 3 && measure(font, word.slice(0, n + 1) + '-') <= w) n++
        line = word.slice(0, n) + '-'
        us[i] = us[i].slice(n)
      } else if (how === 'break' || how === 'hyphen') {
        let cut = ''
        for (const ch of us[i]) {
          if (cut && measure(font, cut + ch) > w) break
          cut += ch
        }
        line = cut
        us[i] = us[i].slice(cut.length)
        if (!us[i]) i++
      }
      break
    }
    lines.push(line.trimEnd())
  }
  return lines
}
