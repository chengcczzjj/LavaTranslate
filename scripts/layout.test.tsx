import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { BlockColors, OcrLine, TranslatedBlock } from '../src/shared/types'
import { layoutBlocks } from '../src/renderer/src/lib/layout'
import { breakLines, fontOf, measure, tokenize, type Slot } from '../src/renderer/src/lib/fit'
import { TranslationLayer } from '../src/renderer/src/components/TranslationLayer'

function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
const overlap = (a: Slot, b: Slot) => a.x < b.x + b.w - 0.01 && a.x + a.w > b.x + 0.01 && a.y < b.y + b.h - 0.01 && a.y + a.h > b.y + 0.01
const line = (id: number, text: string, x: number, y: number, w: number, h: number): OcrLine => ({ id, text, box: { x, y, w, h }, score: 0.99 })
const block = (key: string, ids: number[], translation: string, role: TranslatedBlock['role'] = 'title', keep = false): TranslatedBlock => ({ key, lineIds: ids, source: '', translation, role, keep })
const style = (patch: Partial<BlockColors> = {}): BlockColors => ({ bg: '#ffffff', fg: '#20232b', bold: false, center: false, right: false, freeL: 0, freeR: 1000, inkTop: [], inkBot: [], ...patch })
interface Case { name: string; lines: OcrLine[]; blocks: TranslatedBlock[]; colors?: Record<number, BlockColors>; lang?: string; truncated?: boolean }
const mixedLines = [line(1, 'Big title', 24, 38, 220, 58), line(2, 'Small label', 270, 39, 100, 12), line(3, 'Following paragraph stays here', 24, 114, 480, 20)]
const cases: Case[] = [
  { name: '大标题旁的小字位于顶部，像素探针可能漏掉', lines: mixedLines, blocks: [block('title', [1], '复杂截图中的标题排版保护'), block('keep', [2], 'Small label', 'caption', true), block('body', [3], '下方正文保持自己的位置', 'paragraph')], truncated: false },
  { name: '极长标题：省略显示，完整译文保留', lines: mixedLines, blocks: [block('title', [1], '这是非常长的标题，需要在空间不足时保护旁边和下方文字的位置。'.repeat(12))], truncated: true },
  { name: '相邻两列同时扩展，后到的译文避让先到的', lines: [line(1, 'Left', 24, 40, 90, 30), line(2, 'Right', 260, 40, 100, 16), line(3, 'Next row', 24, 126, 480, 20)], blocks: [block('left', [1], '左边标题变长之后需要换行'), block('right', [2], '右侧小字也需要翻译并保持位置', 'caption')] },
  { name: '多行段落，右侧侧栏不被遮盖', lines: [line(1, 'A paragraph wraps', 24, 30, 260, 20), line(2, 'across these lines.', 24, 58, 210, 20), line(3, 'Sidebar', 320, 34, 150, 14), line(4, 'Another section', 24, 122, 400, 20)], blocks: [block('p', [1, 2], '这是跨越多行的正文，翻译后需要根据段落本身的范围排版，而且不能进入旁边侧栏。', 'paragraph'), block('side', [3], '独立的小字侧栏', 'caption')] },
  { name: '靠右标题保持右对齐并避开屏幕边缘', lines: [line(1, 'Right title', 350, 38, 168, 44), line(2, 'Left label', 20, 40, 120, 16)], blocks: [block('right', [1], '靠右显示的较长标题')], colors: { 1: style({ right: true, freeL: 800, freeR: 0 }), 2: style() } },
  { name: '居中标题与两侧小字保持间距', lines: [line(1, 'Centered', 170, 38, 180, 44), line(2, 'Left', 24, 40, 90, 14), line(3, 'Right', 420, 40, 100, 14)], blocks: [block('center', [1], '这个较长标题居中显示')], colors: { 1: style({ center: true, freeL: 600, freeR: 600 }), 2: style(), 3: style() } },
  { name: 'OCR 框轻微交叠，背景补丁保护旁边的小字', lines: [line(1, 'Wide title', 24, 38, 250, 58), line(2, 'Tiny', 268, 40, 90, 12)], blocks: [block('title', [1], '标题背景不能涂掉小字')] },
  { name: '紧贴底边的超长翻译与长网址', lines: [line(1, 'Bottom', 24, 142, 170, 22), line(2, 'Keep', 210, 142, 80, 18)], blocks: [block('bottom', [1], 'https://example.com/an/extremely/long/path/that/will/not/fit/inside/this/label'.repeat(5), 'ui')], lang: 'en', truncated: true },
  { name: '保留列表符号', lines: [line(1, '•', 20, 40, 10, 20), line(2, 'List item', 38, 40, 220, 20)], blocks: [block('list', [1, 2], '• 需要保留列表前面的符号', 'paragraph')] },
  { name: '保留下拉箭头，不能用无限宽兜底覆盖它', lines: [{ ...line(1, 'Save ▼', 24, 40, 74, 24), cx: [5, 15, 25, 35, 47, 65] }, line(2, 'Next', 110, 40, 80, 22)], blocks: [{ ...block('icon', [1], '保存这个菜单项目的所有修改', 'ui'), source: 'Save' }] },
  { name: '竖排文字', lines: [{ ...line(1, '縦書き', 24, 20, 30, 130), vertical: true }, line(2, '旁边', 64, 24, 60, 18)], blocks: [block('vertical', [1], '竖排文字')] }
]

function scaled(c: Case, scale: number) {
  const lines = c.lines.map((l) => ({ ...l, box: { x: l.box.x * scale, y: l.box.y * scale, w: l.box.w * scale, h: l.box.h * scale }, cx: l.cx?.map((v) => v * scale) }))
  const colors = Object.fromEntries(lines.map((l) => {
    const s = c.colors?.[l.id] ?? style()
    return [l.id, { ...s, freeL: s.freeL * scale, freeR: s.freeR * scale }]
  }))
  return { lines, colors }
}

function check(c: Case, scale: number) {
  const { lines, colors } = scaled(c, scale)
  const layouts = layoutBlocks(c.blocks, lines, colors, scale, 540, 170, c.lang ?? 'zh-Hans')
  assert(layouts.length === c.blocks.filter((b) => !b.keep).length, `${c.name}: translation disappeared at scale ${scale}`)
  for (const [i, layout] of layouts.entries()) {
    const b = c.blocks.find((b) => b.key === layout.key)!
    assert(layout.fullText === b.translation, `${c.name}: full translation was lost`)
    const foreign = c.lines.filter((l) => !b.lineIds.includes(l.id))
    const textPieces = layout.pieces.filter((p) => p.text)
    for (const [j, p] of textPieces.entries()) {
      assert(p.x >= 0 && p.y >= 0 && p.x + p.w <= 540.01 && p.y + p.h <= 170.01, `${c.name}: outside image`)
      assert(!foreign.some((l) => overlap(p, l.box)), `${c.name}: text covers a neighboring OCR line`)
      assert(!textPieces.slice(0, j).some((q) => overlap(p, q)), `${c.name}: own lines overlap`)
      if (!p.vertical) assert(measure(fontOf(layout.weight, layout.fontSize, layout.family), p.text) <= p.w + 0.01, `${c.name}: glyph width exceeds assigned width`)
    }
    for (const p of layout.patches) {
      assert(!foreign.some((l) => overlap(p, l.box)), `${c.name}: patch erases a neighboring OCR line`)
      for (const earlier of layouts.slice(0, i)) assert(!earlier.pieces.filter((q) => q.text).some((q) => overlap(p, q)), `${c.name}: patch covers earlier translation`)
    }
    for (const earlier of layouts.slice(0, i)) assert(!textPieces.some((p) => earlier.pieces.filter((q) => q.text).some((q) => overlap(p, q))), `${c.name}: translated blocks overlap`)
  }
  if (c.truncated !== undefined) assert(layouts[0].truncated === c.truncated, `${c.name}: unexpected truncation at scale ${scale}`)
  if (layouts[0].truncated) assert(layouts[0].pieces.some((p) => p.text.endsWith('…')), `${c.name}: missing ellipsis`)
  return layouts
}

Object.assign(window, { runLayoutTests() {
  const passed: string[] = []
  for (const c of cases) {
    for (const scale of [1, 1.25, 1.5, 2, 3]) check(c, scale)
    passed.push(c.name + ' × 5 scales')
  }
  const titleCase = check(cases[0], 1)
  assert(titleCase.find((l) => l.key === 'body')?.pieces.find((p) => p.text)?.x === 24, 'title padding shifted the next paragraph')
  const font = '400 16px sans-serif'
  assert(breakLines(['中'], font, () => 1, 1) === null, 'single glyph must not overflow')
  assert(breakLines(['translation'], font, () => 3, 3, () => 'hyphen') === null, 'hyphen prefix must fit')
  assert(breakLines(['abc'], font, () => 0, 4) === null, 'zero width must fail')
  assert(breakLines(['abc'], font, () => 1, Infinity, () => 'skip') === null, 'infinite skip must fail')
  const emoji = '👨‍👩‍👧‍👦'
  assert(breakLines([emoji + emoji], font, () => measure(font, emoji) + 0.01, 2)?.join('') === emoji + emoji, 'graphemes must stay whole')
  const units = tokenize('中文（括号）与 English words')
  assert(breakLines(units, font, () => 500, 1)?.join('') === '中文（括号）与 English words', 'ordinary wrapping preserves text')
  passed.push('narrow glyph / hyphen / zero width / finite skip / grapheme / normal text')

  // 已到达的块不因后续块流入而重新跳动；keep/待翻译原文同样作为障碍。
  const c = cases[2], data = scaled(c, 1)
  const initial = layoutBlocks(c.blocks.slice(0, 1), data.lines, data.colors, 1, 540, 170, 'zh-Hans')
  const complete = check(c, 1)
  assert(JSON.stringify(initial[0]) === JSON.stringify(complete[0]), 'streaming shifted an earlier block')
  check({ ...c, blocks: [...c.blocks].reverse() }, 1)
  passed.push('streaming stability and reversed arrival order')

  const container = document.createElement('div')
  document.body.style.cssText = 'margin:20px;background:#eef0f4;font:14px sans-serif;color:#252a35'
  document.body.append(container)
  flushSync(() => createRoot(container).render(<>
    <h2>截图翻译排版回归 · 真实 Chromium 字体与共享组件</h2>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 540px)', gap: 18 }}>
      {cases.slice(0, 8).map((c) => {
        const { lines, colors } = scaled(c, 1)
        return <section key={c.name}><div style={{ marginBottom: 8 }}>{c.name}</div>
          <div style={{ width: 540, height: 170, background: 'white', position: 'relative', border: '1px solid #d2d5dc' }}>
            {lines.map((l) => <div key={l.id} style={{ position: 'absolute', left: l.box.x, top: l.box.y, width: l.box.w, height: l.box.h, lineHeight: `${l.box.h}px`, fontSize: Math.max(8, l.box.h * 0.7), whiteSpace: 'nowrap', overflow: 'hidden' }}>{l.text}</div>)}
            <TranslationLayer lines={lines} blocks={c.blocks} colors={colors} scale={1} width={540} height={170} targetLang={c.lang ?? 'zh-Hans'} peek={false} pending={null} />
          </div>
        </section>
      })}
    </div>
  </>))
  const truncated = document.querySelector('[data-block="title"][title]')
  assert(truncated?.getAttribute('title') === cases[1].blocks[0].translation, 'truncated block exposes full translation on hover')
  return { status: 'passed', layoutCases: cases.length * 5 + 2, passed }
} })
