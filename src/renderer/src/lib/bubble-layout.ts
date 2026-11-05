import type { BlockColors, OcrLine, Rect, TranslatedBlock } from '@shared/types'
import type { Layout, Piece } from './layout'
import { ellipsizeProse, familyFor, fontOf, isCjk, measure, wrapProse } from './fit'

/** Fit a bubble's paragraphs together. Horizontal scripts follow the original
 * vertical flow with whole lines turned clockwise; keys preserve hover/copy. */
export function layoutBubble(
  blocks: TranslatedBlock[], own: OcrLine[], region: Rect,
  colors: Record<number, BlockColors>, scale: number, language: string,
  width: number, height: number, obstacles: Rect[]
): Layout[] | null {
  const box = { x: region.x / scale, y: region.y / scale, w: region.w / scale, h: region.h / scale }
  if (box.x < 0 || box.y < 0 || box.x + box.w > width || box.y + box.h > height) return null
  if (obstacles.some((b) => box.x < b.x + b.w + 3 && box.x + box.w > b.x - 3 && box.y < b.y + b.h + 3 && box.y + box.h > b.y - 3)) return null
  const lineMap = new Map(own.map((l) => [l.id, l]))
  const ordered = [...blocks].sort((a, b) =>
    Math.max(...b.lineIds.map((id) => lineMap.get(id)!.box.x)) - Math.max(...a.lineIds.map((id) => lineMap.get(id)!.box.x)))
  const texts = ordered.map((b) => b.translation.replace(/\s+/g, ' ').trim())
  if (texts.some((t) => !t)) return null
  const sideways = !isCjk(language)
  const inlineSize = sideways ? box.h : box.w
  const crossSize = sideways ? box.w : box.h
  const sizes = own.map((l) => l.box.w / scale * 0.72).sort((a, b) => a - b)
  // Leave room for a short phrase (about 15 average-width Latin characters).
  // Maximizing only font size fills tall bubbles with one huge word per row.
  const phraseWidth = Math.max(6, Math.min(15, texts.join(' ').length)) * 0.5
  const base = Math.min(sizes[sizes.length >> 1] * 1.06, inlineSize / phraseWidth)
  const floor = Math.min(base, Math.max(10, base * 0.55))
  const family = familyFor(language)
  const weight = own.filter((l) => colors[l.id].bold).length * 2 > own.length ? 600 : 400
  let placed: string[][] | null = null, fontSize = base
  const clipped = new Set<number>()
  const fitAt = (fs: number, emergency = false) => {
    const lead = fs * 1.3, maxRows = Math.floor(crossSize / lead), font = fontOf(weight, fs, family)
    const rows: string[][] = []
    let remaining = maxRows
    for (const text of texts) {
      const wrapped = wrapProse(text, font, () => inlineSize, remaining, language, emergency)
      if (!wrapped) break
      rows.push(wrapped)
      remaining -= wrapped.length
    }
    return rows.length === texts.length ? rows : null
  }
  for (let fs = base; fs >= floor; fs = Math.max(floor, fs * 0.95)) {
    placed = fitAt(fs)
    if (placed) { fontSize = fs; break }
    if (fs === floor) break
  }
  if (!placed) { placed = fitAt(floor, true); fontSize = floor }
  if (!placed) {
    // Reserve space for each paragraph. Preserve complete strings for copying;
    // only the displayed tail is shortened when the bubble truly cannot fit.
    fontSize = floor
    const maxRows = Math.floor(crossSize / (floor * 1.3))
    if (maxRows < texts.length) return null
    const font = fontOf(weight, floor, family)
    const needed = texts.map((text) => wrapProse(text, font, () => inlineSize, maxRows, language)?.length ?? maxRows)
    const counts = texts.map(() => 1)
    let remaining = maxRows - texts.length
    // Share scarce columns only among paragraphs that still need them. Short
    // paragraphs can precede OR follow a long paragraph without wasting space.
    while (remaining > 0) {
      let allocated = false
      for (let i = 0; i < texts.length && remaining > 0; i++) {
        if (counts[i] >= needed[i]) continue
        counts[i]++; remaining--; allocated = true
      }
      if (!allocated) break
    }
    placed = texts.map((text, i) => {
      const count = counts[i]
      const full = wrapProse(text, font, () => inlineSize, count, language)
      if (!full) clipped.add(i)
      const rows = full ?? ellipsizeProse(text, font, () => inlineSize, count, language) ?? []
      return rows
    })
    if (placed.some((rows) => !rows.length)) return null
  }
  const lead = fontSize * 1.3
  let offset = (crossSize - placed.reduce((n, rows) => n + rows.length, 0) * lead) / 2
  return ordered.map((block, i) => {
    const ls = block.lineIds.map((id) => lineMap.get(id)!)
    const st = colors[ls[0].id]
    const pieces: Piece[] = placed![i].map((text) => {
      const advance = measure(fontOf(weight, fontSize, family), text)
      const p: Piece = sideways
        ? { x: box.x + box.w - offset - lead, y: box.y + (box.h - advance) / 2, w: lead, h: advance, text, bg: st.bg, sideways: 'sideways-rl' }
        : { x: box.x + (box.w - advance) / 2, y: box.y + offset, w: advance, h: lead, text, bg: st.bg }
      offset += lead
      return p
    })
    // Original covers may overlap the other paragraph's translated position.
    // They are always painted in the shared background plane, before ANY text.
    const patches: Piece[] = ls.map((l) => ({
      x: l.box.x / scale, y: l.box.y / scale, w: l.box.w / scale, h: l.box.h / scale, bg: colors[l.id].bg, text: ''
    }))
    const x0 = Math.min(...pieces.map((p) => p.x)), x1 = Math.max(...pieces.map((p) => p.x + p.w))
    const y0 = Math.min(...pieces.map((p) => p.y)), y1 = Math.max(...pieces.map((p) => p.y + p.h))
    return {
      key: block.key, pieces, patches, truncated: clipped.has(i), fullText: block.translation,
      fontSize, fg: st.fg, family, weight, align: 'center',
      box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    }
  })
}
