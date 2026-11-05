import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { LANGUAGES, type TranslatedBlock } from '../src/shared/types'
import { TranslationLayer } from '../src/renderer/src/components/TranslationLayer'
import { layoutBlocks } from '../src/renderer/src/lib/layout'
import { breakLines, fontOf, isCjk, isRtl, measure, tokenize, wrapProse } from '../src/renderer/src/lib/fit'
import { bubbleFixture } from './bubble-layout.test'

function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
// Fixed translations exercise layout without depending on a network/model.
export const bubbleTranslations: Record<string, [string, string, string]> = {
  en: ["Oh, so this is the one I've heard so much about...", 'The osmanthus, huh.', "It's already fully autumn..."],
  fr: ["Ah, c’est donc celle dont j’ai tant entendu parler…", 'De l’osmanthe, hein.', 'L’automne est déjà bien installé…'],
  de: ['Ach, das ist also die, von der ich schon so viel gehört habe…', 'Osmanthus, also.', 'Es ist schon richtig Herbst…'],
  es: ['Ah, así que es de quien tanto he oído hablar…', 'El osmanto, ¿eh?', 'Ya estamos en pleno otoño…'],
  ru: ['А, так это та, о которой я столько слышала…', 'Османтус, да.', 'Уже совсем осень…'],
  pt: ['Ah, então é aquela de quem tanto ouvi falar…', 'O osmanto, hein.', 'Já estamos em pleno outono…'],
  it: ['Ah, quindi è quella di cui ho tanto sentito parlare…', 'L’osmanto, eh.', 'Ormai è proprio autunno…'],
  vi: ['Ồ, vậy đây là người mà tôi đã nghe nhắc đến rất nhiều…', 'Hoa mộc hương nhỉ.', 'Đã vào hẳn mùa thu rồi…'],
  th: ['อ๋อ คนนี้เองที่ฉันได้ยินชื่อมานานแล้ว…', 'ดอกหอมหมื่นลี้สินะ', 'เข้าสู่ฤดูใบไม้ร่วงเต็มตัวแล้ว…'],
  ar: ['آه، إذن هذه هي التي سمعت عنها الكثير…', 'إنها أزهار الأوسمانثوس.', 'لقد حل الخريف تمامًا…']
}

const makeBlocks = (texts: string[]): TranslatedBlock[] => [
  { key: 'left', lineIds: [2, 1], source: '', translation: texts[0], role: 'paragraph' },
  { key: 'right-first', lineIds: [4], source: '', translation: texts[1], role: 'paragraph' },
  { key: 'right-second', lineIds: [3], source: '', translation: texts[2], role: 'paragraph' }
]

export function runMultilingualLayoutTests() {
  let cases = 0
  const metrics: { language: string; columns: number[]; fontSize: number[] }[] = []
  const horizontal = LANGUAGES.filter((l) => !isCjk(l.code)).map((l) => l.code)
  assert(horizontal.every((l) => bubbleTranslations[l]), 'every supported horizontal language needs a real-script fixture')
  for (const scale of [1, 1.25, 1.5, 2, 3]) {
    const { lines, colors } = bubbleFixture(scale)
    for (const lang of [...horizontal, 'fr-CA', 'de-DE']) {
      const texts = bubbleTranslations[lang.split('-')[0]]
      const blocks = makeBlocks(texts)
      const layouts = layoutBlocks(blocks, lines, colors, scale, 1000, 600, lang)
      const reversed = layoutBlocks([...blocks].reverse(), lines, colors, scale, 1000, 600, lang)
      assert(layouts.length === 3, `${lang}: a paragraph disappeared`)
      const allPieces = layouts.flatMap((l) => l.pieces.filter((p) => p.text))
      for (const l of layouts) {
        const expected = blocks.find((b) => b.key === l.key)!.translation
        const normalize = (s: string) => lang === 'th' ? s.replace(/\s/g, '') : s.replace(/\s+/g, ' ')
        assert(!l.truncated && normalize(l.pieces.map((p) => p.text).join(' ')) === normalize(expected), `${lang}: words lost or split`)
        assert(l.fontSize >= 18, `${lang}: ordinary prose shrank too far`)
        const peer = reversed.find((r) => r.key === l.key)
        assert(JSON.stringify(l) === JSON.stringify(peer), `${lang}: arrival order changed layout`)
        const region = colors[blocks.find((b) => b.key === l.key)!.lineIds[0]].textRegion!.box
        for (const p of l.pieces) {
          assert(p.sideways === 'sideways-rl' && !p.vertical, `${lang}: must rotate whole lines`)
          assert(p.x >= region.x / scale - 0.01 && p.y >= region.y / scale - 0.01 && p.x + p.w <= (region.x + region.w) / scale + 0.01 && p.y + p.h <= (region.y + region.h) / scale + 0.01, `${lang}: crossed safe bubble area`)
          assert(measure(fontOf(l.weight, l.fontSize, l.family), p.text) <= p.h + 0.01, `${lang}: text exceeds column length`)
          assert(!allPieces.some((q) => q !== p && p.x < q.x + q.w - 0.01 && p.x + p.w > q.x + 0.01 && p.y < q.y + q.h - 0.01 && p.y + p.h > q.y + 0.01), `${lang}: columns overlap`)
        }
      }
      const [left, first, second] = layouts
      assert(first.fontSize === second.fontSize && second.box.x + second.box.w <= first.box.x + 0.01, `${lang}: split blocks must share size and progress right-to-left`)
      assert(left.pieces.length >= 1 && left.pieces.length <= 4, `${lang}: excessive columns for short speech`)
      assert(first.pieces.length + second.pieces.length <= 4, `${lang}: excessive columns for right bubble`)
      if (scale === 1) metrics.push({ language: lang, columns: [left.pieces.length, first.pieces.length + second.pieces.length], fontSize: [left.fontSize, first.fontSize].map((n) => Math.round(n * 10) / 10) })
      cases++
    }
    // A German compound must first be fitted as a whole word, even beyond the
    // old 16-character hard-break threshold. More text may use more columns.
    for (const text of ['Hallo!', 'Die Herbstblumenlandschaften sind wunderschön.', 'Ach, von dieser Person habe ich wirklich schon sehr viel gehört. Jetzt kann ich sie endlich kennenlernen.']) {
      const l = layoutBlocks([makeBlocks([text, '', ''])[0]], lines, colors, scale, 1000, 600, 'de')[0]
      assert(l && !l.truncated && l.pieces.map((p) => p.text).join(' ') === text, 'German long word or expanded sentence was split/lost')
      assert(text !== 'Hallo!' || l.pieces.length === 1, 'short speech must use only one column')
      cases++
    }
    const huge = makeBlocks(['Eine sehr lange Beschreibung der wunderschönen Herbstlandschaft. '.repeat(80), '', ''])[0]
    const truncated = layoutBlocks([huge], lines, colors, scale, 1000, 600, 'de')[0]
    assert(truncated?.truncated && truncated.fullText === huge.translation && truncated.pieces.at(-1)!.text.endsWith('…'), 'overflow must retain full copy text and show ellipsis')
    cases++

    for (const shortFirst of [true, false]) {
      const texts = ['Ja…', 'Eine ausführliche Beschreibung des Herbstes. '.repeat(80)]
      if (!shortFirst) texts.reverse()
      const uneven = makeBlocks(['', ...texts]).slice(1)
      const unevenLayouts = layoutBlocks(uneven, lines, colors, scale, 1000, 600, 'de')
      assert(unevenLayouts.length === 2 && unevenLayouts[0].truncated === !shortFirst && unevenLayouts[1].truncated === shortFirst, 'only the shortened paragraph should be marked truncated')
      const available = Math.floor(colors[4].textRegion!.box.w / scale / (unevenLayouts[0].fontSize * 1.3))
      assert(unevenLayouts.reduce((n, l) => n + l.pieces.length, 0) === available, 'a short paragraph must return unused columns to the long paragraph in either order')
      cases++
    }
    const thai = makeBlocks([bubbleTranslations.th[0].repeat(80), '', ''])[0]
    const thaiLayout = layoutBlocks([thai], lines, colors, scale, 1000, 600, 'th')[0]
    assert(thaiLayout.truncated && thaiLayout.pieces[0].text.length > 2, 'long Thai must preserve a readable prefix rather than just an ellipsis')
    cases++

    const noRegion = Object.fromEntries(Object.entries(colors).map(([id, c]) => [id, { ...c, textRegion: undefined }]))
    for (const lang of horizontal) {
      const b = makeBlocks(['2026', '', ''])[0]
      const l = layoutBlocks([b], lines, noRegion, scale, 1000, 600, lang)[0]
      assert(l?.pieces.filter((p) => p.text).every((p) => p.sideways === 'sideways-rl'), `${lang}: no-bubble fallback must rotate too`)
      const prose = layoutBlocks([makeBlocks(bubbleTranslations[lang])[0]], lines, noRegion, scale, 1000, 600, lang)[0]
      assert(prose && prose.pieces.filter((p) => p.text).every((p) => p.sideways === 'sideways-rl' && measure(fontOf(prose.weight, prose.fontSize, prose.family), p.text) <= p.h), `${lang}: fallback prose must fit along the column`)
      const flat = lines.map((l) => ({ ...l, vertical: false }))
      const h = layoutBlocks([b], flat, noRegion, scale, 1000, 600, lang)[0]
      assert(h && h.pieces.every((p) => !p.sideways && !p.vertical), `${lang}: horizontal source must remain horizontal`)
      cases += 3
    }
    for (const lang of ['zh-Hans', 'zh-Hant', 'ja-JP', 'ko-KR']) {
      const l = layoutBlocks([makeBlocks(['秋', '', ''])[0]], lines, noRegion, scale, 1000, 600, lang)[0]
      assert(l?.pieces.filter((p) => p.text).every((p) => p.vertical && !p.sideways), `${lang}: CJK should stay upright`)
      cases++
    }
    const reverseSource = lines.map((l) => ({ ...l, rotation: 270 as const }))
    const reverse = layoutBlocks([makeBlocks(['Herbst', '', ''])[0]], reverseSource, noRegion, scale, 1000, 600, 'de')[0]
    assert(reverse.pieces.filter((p) => p.text).every((p) => p.sideways === 'sideways-lr'), 'source 270° rotation must retain its direction')
    cases++
  }
  const font = '400 24px sans-serif', prose = 'bonjour bonjour bonjour bonjour bonjour bonjour bonjour'
  const width = measure(font, 'bonjour bonjour bonjour') + 1
  const greedy = breakLines(tokenize(prose), font, () => width, 5, () => 'fail')!
  const balanced = wrapProse(prose, font, () => width, 5, 'fr')!
  assert(balanced.length === greedy.length && balanced.join(' ') === prose, 'balancing must preserve text and minimum column count')
  const shortest = (rows: string[]) => Math.min(...rows.map((r) => measure(font, r)))
  assert(shortest(balanced) > shortest(greedy) * 1.5, 'balancing must remove the orphan tail without extra columns')
  cases++

  const { canvas, lines, colors } = bubbleFixture(1)
  const host = document.createElement('section')
  host.className = 'multilingual-regression'
  document.body.append(host)
  flushSync(() => createRoot(host).render(<>
    {['fr', 'de', 'vi', 'th', 'ar'].map((lang) => <section key={lang} data-language={lang}>
      <h3>{lang} · whole-line rotation / balanced columns</h3>
      <div style={{ position: 'relative', width: 1000, height: 600 }}>
        <img src={canvas.toDataURL()} width={1000} height={600} />
        <TranslationLayer lines={lines} blocks={makeBlocks(bubbleTranslations[lang])} colors={colors} scale={1} width={1000} height={600} targetLang={lang} peek={false} pending={null} />
      </div>
    </section>)}
  </>))
  for (const lang of ['fr', 'de', 'vi', 'th', 'ar']) for (const element of host.querySelectorAll<HTMLElement>(`[data-language="${lang}"] .tl-line`)) {
    const style = getComputedStyle(element)
    assert(style.writingMode === 'sideways-rl', `${lang}: DOM did not rotate`)
    assert(style.direction === (isRtl(lang) ? 'rtl' : 'ltr'), `${lang}: wrong within-line reading direction`)
  }
  return { cases, metrics, passed: 'All 10 horizontal target languages + locale variants: 90° / balanced column count / full words / German compounds / Thai segmentation / Arabic direction / no-bubble fallback / 5 scales' }
}
