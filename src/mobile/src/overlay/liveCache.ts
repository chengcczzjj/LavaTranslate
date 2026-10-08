// 实时翻译的译文缓存：滑动后重新读屏，已经翻过的文字直接用缓存的译文，只把新出现的行发给模型。
// 以「块」为单位缓存（模型把几行合成一段来翻），新屏幕上连续几行和某个缓存块的原文完全一致就直接套用。
import type { OcrLine, TranslatedBlock } from '@shared/types'

interface Entry {
  lines: string[]
  translation: string
  source: string
  keep?: boolean
  role?: TranslatedBlock['role']
}

const LIMIT = 800

/** 比较用：统一全角半角、空白，忽略大小写（OCR 偶尔认错大小写） */
const norm = (t: string) => t.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

export class LiveCache {
  private target = ''
  private entries = new Map<string, Entry>()
  /** 块的第一行 → 以它开头的块 */
  private byFirst = new Map<string, Set<string>>()

  /** 换了目标语言：之前的译文都不能用了 */
  useTarget(target: string) {
    if (target === this.target) return
    this.target = target
    this.entries.clear()
    this.byFirst.clear()
  }

  add(lines: OcrLine[], b: TranslatedBlock) {
    const texts = b.lineIds.map((id) => lines.find((l) => l.id === id)?.text ?? '').map(norm)
    if (!texts.length || texts.some((t) => !t)) return
    const key = texts.join('\n')
    this.entries.delete(key)
    this.entries.set(key, { lines: texts, translation: b.translation, source: b.source, keep: b.keep, role: b.role })
    let set = this.byFirst.get(texts[0])
    if (!set) this.byFirst.set(texts[0], (set = new Set()))
    set.add(key)
    // 最久没用的先丢
    while (this.entries.size > LIMIT) {
      const old = this.entries.keys().next().value as string
      const e = this.entries.get(old)!
      this.entries.delete(old)
      this.byFirst.get(e.lines[0])?.delete(old)
    }
  }

  /** 新屏幕的行（按 id 排好）里能直接套用缓存的块，和剩下要翻的行 */
  match(lines: OcrLine[], frame: number): { blocks: TranslatedBlock[]; rest: OcrLine[] } {
    const ns = lines.map((l) => norm(l.text))
    const used = new Array<boolean>(lines.length).fill(false)
    const blocks: TranslatedBlock[] = []
    for (let i = 0; i < lines.length; i++) {
      if (used[i]) continue
      const keys = this.byFirst.get(ns[i])
      if (!keys?.size) continue
      // 先试行数多的块
      const cands = [...keys].map((k) => this.entries.get(k)!).filter(Boolean).sort((a, b) => b.lines.length - a.lines.length)
      for (const e of cands) {
        const n = e.lines.length
        if (i + n > lines.length) continue
        let ok = true
        for (let j = 0; j < n && ok; j++) ok = !used[i + j] && ns[i + j] === e.lines[j]
        if (!ok) continue
        const ids = lines.slice(i, i + n).map((l) => l.id)
        for (let j = 0; j < n; j++) used[i + j] = true
        blocks.push({ key: `c${frame}-${ids.join('-')}`, lineIds: ids, source: e.source, translation: e.translation, keep: e.keep, role: e.role })
        // 用过的挪到最新
        const key = e.lines.join('\n')
        this.entries.delete(key)
        this.entries.set(key, e)
        break
      }
    }
    return { blocks, rest: lines.filter((_, i) => !used[i]) }
  }
}
