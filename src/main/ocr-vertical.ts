import type { Rect } from '../shared/types'
import type { RgbaImage } from './ocr'

/** Turn upright glyphs in a vertical column into a horizontal recognition strip.
 * Projection gaps separate glyphs; nearby fragments (こ / 三 / ellipsis) stay
 * together. Samples remain upright and preserve their relative dimensions. */
export function unfoldVertical(img: RgbaImage, rect: Rect): (RgbaImage & { glyphs: number }) | null {
  const { data, width, height } = img
  const x0 = Math.max(0, Math.ceil(rect.x + rect.w * 0.12))
  const x1 = Math.min(width, Math.floor(rect.x + rect.w * 0.88))
  const y0 = Math.max(0, Math.floor(rect.y))
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h))
  const edges: number[][] = [[], [], []]
  for (let y = y0; y < y1; y++) for (const x of [x0, x1 - 1]) {
    const p = (y * width + x) * 4
    for (let c = 0; c < 3; c++) edges[c].push(data[p + c])
  }
  if (x1 <= x0 || y1 <= y0) return null
  const bg = edges.map((v) => v.sort((a, b) => a - b)[v.length >> 1])
  const runs: { top: number; bottom: number }[] = []
  let left = x1, right = x0, start = -1
  for (let y = y0; y < y1; y++) {
    let ink = false
    for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 4
      if (Math.max(Math.abs(bg[0] - data[p]), Math.abs(bg[1] - data[p + 1]), Math.abs(bg[2] - data[p + 2])) < 64) continue
      ink = true
      left = Math.min(left, x)
      right = Math.max(right, x + 1)
    }
    if (ink && start < 0) start = y
    if (!ink && start >= 0) { runs.push({ top: start, bottom: y }); start = -1 }
  }
  if (start >= 0) runs.push({ top: start, bottom: y1 })
  const em = right - left
  if (em < 4 || !runs.length) return null
  const glyphs: typeof runs = []
  for (const run of runs) {
    const prev = glyphs.at(-1)
    if (prev && run.bottom - prev.top <= em * 1.15 && run.top - prev.bottom < em * 0.5) prev.bottom = run.bottom
    else glyphs.push({ ...run })
  }
  // Connected script / noise is not a stack of upright square glyphs. Let the
  // rotated candidates or vision model handle it instead of slicing letters.
  if (glyphs.length < 2 || glyphs.some((g) => g.bottom - g.top > em * 1.65)) return null
  const side = 48, outW = side * glyphs.length
  const out = new Uint8Array(outW * side * 4)
  for (let p = 0; p < out.length; p += 4) { out[p] = bg[0]; out[p + 1] = bg[1]; out[p + 2] = bg[2]; out[p + 3] = 255 }
  glyphs.forEach((g, i) => {
    const h = g.bottom - g.top
    const scale = 40 / Math.max(em, h)
    const wOut = Math.round(em * scale), hOut = Math.round(h * scale)
    for (let y = 0; y < hOut; y++) for (let x = 0; x < wOut; x++) {
      const source = ((g.top + Math.min(h - 1, Math.floor(y / scale))) * width + left + Math.min(em - 1, Math.floor(x / scale))) * 4
      const dest = ((y + Math.floor((side - hOut) / 2)) * outW + i * side + x + Math.floor((side - wOut) / 2)) * 4
      out.set(data.subarray(source, source + 4), dest)
    }
  })
  return { data: out, width: outW, height: side, glyphs: glyphs.length }
}
