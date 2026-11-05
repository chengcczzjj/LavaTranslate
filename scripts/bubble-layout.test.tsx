import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { BlockColors, OcrLine, TranslatedBlock } from '../src/shared/types'
import { sampleColors } from '../src/renderer/src/lib/colors'
import { sampleTextRegions } from '../src/renderer/src/lib/text-regions'
import { layoutBlocks } from '../src/renderer/src/lib/layout'
import { TranslationLayer } from '../src/renderer/src/components/TranslationLayer'

function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
const leftText = "Oh, so this is the one I've heard so much about..."
const rightText = "The osmanthus, huh. It's already fully autumn..."
const blocks: TranslatedBlock[] = [
  { key: 'bubble-left', lineIds: [2, 1], source: 'お～これがお噂はかねがね…', translation: leftText, role: 'paragraph' },
  { key: 'bubble-right', lineIds: [4, 3], source: '金木犀ねもうすっかり秋だし', translation: rightText, role: 'paragraph' }
]
const split: TranslatedBlock[] = [blocks[0],
  { ...blocks[1], key: 'right-first', lineIds: [4], translation: 'The osmanthus, huh.' },
  { ...blocks[1], key: 'right-second', lineIds: [3], translation: "It's already fully autumn..." }
]
const source: OcrLine[] = [
  { id: 1, text: 'お噂はかねがね…', score: 0.99, vertical: true, box: { x: 160, y: 110, w: 44, h: 320 } },
  { id: 2, text: 'お～これが', score: 0.99, vertical: true, box: { x: 218, y: 110, w: 44, h: 210 } },
  { id: 3, text: 'もうすっかり秋だし', score: 0.99, vertical: true, box: { x: 750, y: 110, w: 38, h: 290 } },
  { id: 4, text: '金木犀ね', score: 0.99, vertical: true, box: { x: 800, y: 110, w: 38, h: 130 } }
]

export function bubbleFixture(scale: number) {
  const canvas = document.createElement('canvas')
  canvas.width = 1000 * scale; canvas.height = 600 * scale
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.fillStyle = '#ccc'; ctx.fillRect(0, 0, 1000, 600)
  for (const [x, y, rx, ry] of [[220, 280, 190, 260], [790, 270, 140, 250]]) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 6; ctx.strokeStyle = '#000'; ctx.stroke()
  }
  ctx.fillStyle = '#111'; ctx.textBaseline = 'top'
  for (const l of source) {
    ctx.font = `${l.box.w * 0.7}px sans-serif`
    for (const [i, ch] of [...l.text].entries()) ctx.fillText(ch, l.box.x + 5, l.box.y + 4 + i * (l.box.h - 8) / [...l.text].length)
  }
  const lines = source.map((l) => ({ ...l, box: { x: l.box.x * scale, y: l.box.y * scale, w: l.box.w * scale, h: l.box.h * scale } }))
  const px = new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data)
  const colors: Record<number, BlockColors> = Object.fromEntries(lines.map((l) => [l.id, sampleColors(px, canvas.width, canvas.height, l.box, l.box.w)]))
  const start = performance.now()
  sampleTextRegions(px, canvas.width, canvas.height, { x: 0, y: 0, w: canvas.width, h: canvas.height }, lines, colors)
  return { canvas, px, lines, colors, ms: performance.now() - start }
}

export function runBubbleLayoutTests() {
  const times: number[] = []
  for (const scale of [1, 1.25, 1.5, 2, 3]) {
    const { canvas, px, lines, colors, ms } = bubbleFixture(scale)
    times.push(ms)
    assert(colors[1].textRegion?.id === colors[2].textRegion?.id && colors[1].textRegion, 'left columns must share a detected bubble')
    assert(colors[3].textRegion?.id === colors[4].textRegion?.id && colors[3].textRegion, 'right columns must share a detected bubble')
    assert(colors[1].textRegion.id !== colors[3].textRegion.id, 'separate bubbles must not merge')
    for (const list of [blocks, split, [split[2], split[0], split[1]]]) {
      const layouts = layoutBlocks(list, lines, colors, scale, 1000, 600, 'en')
      assert(layouts.length === list.length, 'a bubble paragraph disappeared')
      for (const layout of layouts) {
        assert(!layout.truncated, 'ordinary speech bubble text must fit in full')
        assert(layout.fontSize >= 18, 'rotated bubble text must stay readable')
        const text = layout.pieces.map((p) => p.text).join(' ').replace(/\s+/g, ' ')
        assert(text === list.find((b) => b.key === layout.key)!.translation, 'word was lost or split across lines')
        for (const p of layout.pieces) {
          assert(p.sideways === 'sideways-rl' && !p.vertical, 'English must rotate whole lines clockwise, not use horizontal or upright letters')
          const center = layout.key.startsWith('bubble-left') ? [220, 280, 190, 260] : [790, 270, 140, 250]
          for (const x of [p.x, p.x + p.w]) for (const y of [p.y, p.y + p.h]) {
            assert(((x - center[0]) / (center[2] - 8)) ** 2 + ((y - center[1]) / (center[3] - 8)) ** 2 < 1, 'text crossed bubble outline')
          }
        }
      }
      const right = layouts.filter((l) => l.key.startsWith('right-'))
      if (right.length === 2) {
        assert(right[0].fontSize === right[1].fontSize, 'split paragraphs need one shared font size')
        assert(right[1].box.x + right[1].box.w <= right[0].box.x + 0.01, 'rotated paragraphs must progress right-to-left without overlap')
        assert(right[0].key === 'right-first', 'model arrival order must not reverse speech-bubble reading order')
      }
    }
    const pending = layoutBlocks([split[0], split[1]], lines, colors, scale, 1000, 600, 'en')
    assert(pending.length === 1 && pending[0].key === 'bubble-left', 'pending bubble should not cover untranslated source; other bubbles can render')

    // A black divider in the whitespace must stop expansion. Only the actual
    // source boxes may be treated as already-erased glyphs.
    for (let y = Math.floor(90 * scale); y < 460 * scale; y++) for (let x = Math.floor(290 * scale); x < 296 * scale; x++) {
      const p = (y * canvas.width + x) * 4; px[p] = px[p + 1] = px[p + 2] = 0
    }
    sampleTextRegions(px, canvas.width, canvas.height, { x: 0, y: 0, w: canvas.width, h: canvas.height }, lines, colors)
    const r = colors[1].textRegion!.box
    assert((r.x + r.w) / scale < 290, 'expanded bubble area crossed an illustration/divider')
  }
  const { canvas, lines, colors } = bubbleFixture(1)
  const host = document.createElement('section')
  host.id = 'bubble-regression'
  host.style.cssText = 'position:relative;width:1000px;height:600px;margin-top:20px'
  document.body.append(host)
  flushSync(() => createRoot(host).render(<>
    <img src={canvas.toDataURL()} width={1000} height={600} />
    <TranslationLayer lines={lines} blocks={split} colors={colors} scale={1} width={1000} height={600} targetLang="en" peek={false} pending={null} />
  </>))
  return { cases: 20, timing: times.map(Math.round), passed: 'English bubbles: clockwise 90° / right-to-left columns / full words / split model blocks / reversed stream / pending text / divider × 5 scales' }
}
