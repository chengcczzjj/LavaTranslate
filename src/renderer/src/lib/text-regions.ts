import type { BlockColors, OcrLine, Rect } from '@shared/types'

/** Find a safe horizontal text area inside a flat speech bubble. Coordinates
 * remain relative to the selected image, in physical pixels, like OCR boxes.
 * A connected background separates bubbles even when their text is adjacent.
 * Original glyphs are ignored only AFTER their bubble has been identified. */
export function sampleTextRegions(
  pixels: Uint8Array, imageW: number, imageH: number,
  selection: Rect, lines: OcrLine[], colors: Record<number, BlockColors>
) {
  for (const line of lines) if (colors[line.id]) delete colors[line.id].textRegion
  const vertical = lines.filter((l) => l.vertical && !l.rotation && colors[l.id])
  if (!vertical.length) return
  const width = Math.min(selection.w, imageW - selection.x)
  const height = Math.min(selection.h, imageH - selection.y)
  if (width <= 0 || height <= 0) return
  const step = Math.max(1, Math.ceil(Math.sqrt(width * height / 350_000)))
  const cols = Math.ceil(width / step), rows = Math.ceil(height / step)
  const queue = new Int32Array(cols * rows)
  const maps = new Map<string, Int32Array>()
  const groups = new Map<number, { map: Int32Array; lines: OcrLine[]; touches: number }>()
  let regionId = 0

  for (const line of vertical) {
    const value = parseInt(colors[line.id].bg.slice(1), 16)
    const bg = [...maps.keys()].find((key) => {
      const c = parseInt(key.slice(1), 16)
      return [0, 8, 16].every((shift) => Math.abs(((c >> shift) & 255) - ((value >> shift) & 255)) <= 12)
    }) ?? colors[line.id].bg
    let map = maps.get(bg)
    if (!map) { map = new Int32Array(cols * rows); maps.set(bg, map) }
    const rgb = parseInt(bg.slice(1), 16)
    const red = rgb >> 16, green = (rgb >> 8) & 255, blue = rgb & 255
    const blank = (index: number) => {
      if (map![index]) return map![index] > 0
      const x0 = index % cols * step, y0 = Math.floor(index / cols) * step
      // Test every pixel in a cell, so downsampling cannot jump across a thin
      // bubble outline or an illustration. Negative labels cache barriers.
      for (let y = y0; y < Math.min(height, y0 + step); y++) {
        for (let x = x0; x < Math.min(width, x0 + step); x++) {
          const p = ((selection.y + y) * imageW + selection.x + x) * 4
          if (Math.max(Math.abs(pixels[p] - red), Math.abs(pixels[p + 1] - green), Math.abs(pixels[p + 2] - blue)) > 24) {
            map![index] = -1
            return false
          }
        }
      }
      return true
    }
    // Sample the padded OCR perimeter, avoiding the glyph centers.
    let seed = -1
    const b = line.box
    for (const fy of [0.1, 0.5, 0.9]) {
      for (const fx of [0.05, 0.95, 0.5]) {
        const x = Math.max(0, Math.min(cols - 1, Math.floor((b.x + b.w * fx) / step)))
        const y = Math.max(0, Math.min(rows - 1, Math.floor((b.y + b.h * fy) / step)))
        const p = y * cols + x
        if (blank(p)) { seed = p; break }
      }
      if (seed >= 0) break
    }
    if (seed < 0) continue
    let id = map[seed]
    if (!id) {
      id = ++regionId
      let head = 0, tail = 1, touches = 0
      queue[0] = seed
      map[seed] = id
      while (head < tail) {
        const p = queue[head++], x = p % cols, y = Math.floor(p / cols)
        if (!x) touches |= 1
        if (x === cols - 1) touches |= 2
        if (!y) touches |= 4
        if (y === rows - 1) touches |= 8
        for (const next of [x > 0 ? p - 1 : -1, x < cols - 1 ? p + 1 : -1, y > 0 ? p - cols : -1, y < rows - 1 ? p + cols : -1]) {
          if (next < 0 || map[next] || !blank(next)) continue
          map[next] = id
          queue[tail++] = next
        }
      }
      groups.set(id, { map, lines: [], touches })
    }
    groups.get(id)?.lines.push(line)
  }

  for (const [id, group] of groups) {
    if (!group.lines.length || group.touches === 15) continue // open page, not an enclosed bubble
    const own = group.lines.map((l) => l.box)
    const x0 = Math.min(...own.map((b) => b.x)), x1 = Math.max(...own.map((b) => b.x + b.w))
    const y0 = Math.min(...own.map((b) => b.y)), y1 = Math.max(...own.map((b) => b.y + b.h))
    const em = [...own].sort((a, b) => a.w - b.w)[own.length >> 1].w * 0.72
    const anchor = Math.min(cols - 1, Math.floor((x0 + x1) / 2 / step))
    const top = Math.max(0, Math.floor((y0 - em * 0.3) / step))
    const bottom = Math.min(rows, Math.ceil((y1 + em * 0.3) / step))
    const pad = Math.max(step * 2, em * 0.4)
    const allowed = (x: number, y: number) => group.map[y * cols + x] === id || own.some((b) =>
      x * step >= b.x && (x + 1) * step <= b.x + b.w && y * step >= b.y && (y + 1) * step <= b.y + b.h)
    const spans: { left: number; right: number }[] = []
    for (let y = top; y < bottom; y++) {
      if (!allowed(anchor, y)) { spans.push({ left: 0, right: 0 }); continue }
      let l = anchor, r = anchor
      while (l > 0 && allowed(l - 1, y)) l--
      while (r < cols - 1 && allowed(r + 1, y)) r++
      spans.push({ left: l * step + pad, right: Math.min(width, (r + 1) * step) - pad })
    }
    // Largest safe rectangle crossing the source's vertical center. Text may
    // use the bubble's blank sides, but never its outline or a neighboring image.
    const middle = Math.floor((y0 + y1) / 2 / step) - top
    let best: Rect | undefined, bestArea = 0
    for (let start = 0; start <= middle && start < spans.length; start++) {
      let left = 0, right = width
      for (let end = start; end < spans.length; end++) {
        left = Math.max(left, spans[end].left)
        right = Math.min(right, spans[end].right)
        if (right <= left) break
        const h = (end - start + 1) * step
        if (end < middle || h < em * 2 || right - left < em * 2) continue
        const area = (right - left) * h
        if (area > bestArea) { bestArea = area; best = { x: left, y: (top + start) * step, w: right - left, h } }
      }
    }
    // An unbounded white page is not permission to spread a label across it.
    if (!best || best.w > em * 14 || best.w < (x1 - x0) * 0.9) continue
    const region = { id, box: best, lineIds: group.lines.map((l) => l.id) }
    for (const line of group.lines) colors[line.id].textRegion = region
  }
}
