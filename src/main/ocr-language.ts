import type { OcrLine } from '../shared/types'

type Convert = (text: string) => string
let simplified: Convert | undefined
let traditional: Convert | undefined

async function chineseNormalizer(target: string) {
  if (target !== 'zh-Hans' && target !== 'zh-Hant') return null
  const { Converter } = await import('opencc-js')
  return target === 'zh-Hans'
    ? simplified ??= Converter({ from: 't', to: 'cn' })
    : traditional ??= Converter({ from: 'cn', to: 't' })
}

const scripts: Record<string, RegExp> = {
  ja: /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u,
  ko: /^\p{Script=Hangul}+$/u,
  ru: /^\p{Script=Cyrillic}+$/u,
  th: /^\p{Script=Thai}+$/u,
  ar: /^\p{Script=Arabic}+$/u
}

// Technical labels in a Chinese UI stay verbatim in both languages. Leave
// ordinary foreign words in the line so genuinely mixed prose still translates.
const technicalLabels = /\b(?:(?:Ctrl|Alt|Shift|Win|Cmd|Command)(?:\s*\+\s*[A-Za-z0-9]+)+|OCR|API|AI|CPU|GPU|USB|PDF|URL|HTML|JSON|HTTP|HTTPS|Windows|macOS|Android|iOS|[Ff]\d{1,2})\b/gi

/** Only skip a screenshot when every line is already readable in the requested language. */
export async function matchesTargetLanguage(lines: OcrLine[], target: string): Promise<boolean> {
  const [{ eld }, normalizeChinese] = await Promise.all([import('eld/small'), chineseNormalizer(target)])
  const chineseSelection = normalizeChinese && lines.some(({ text }) => /\p{Script=Han}/u.test(text))
  return lines.every(({ text }) => {
    const prose = chineseSelection ? text.normalize('NFKC').replace(technicalLabels, '') : text
    const letters = prose.replace(/[^\p{L}]/gu, '')
    if (!letters) return true
    if (normalizeChinese) {
      // Han alone is shared with Japanese. Kana, foreign words and confident Japanese
      // detections must remain translatable, even on a mostly Chinese screenshot.
      if (!/^\p{Script=Han}+$/u.test(letters)) return false
      const result = eld.detect(letters)
      if (result.language && result.language !== 'zh' && result.isReliable()) return false
      return normalizeChinese(prose) === prose
    }
    if (!(scripts[target] ?? /^\p{Script=Latin}+$/u).test(letters)) return false
    if (target === 'ko' || target === 'th' || (target === 'ja' && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(letters))) return true
    const result = eld.detect(text)
    return result.language === target && result.isReliable()
  })
}
