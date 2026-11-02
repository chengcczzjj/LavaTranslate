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

/** Only skip a screenshot when every line is already readable in the requested language. */
export async function matchesTargetLanguage(lines: OcrLine[], target: string): Promise<boolean> {
  const [{ eld }, normalizeChinese] = await Promise.all([import('eld/small'), chineseNormalizer(target)])
  return lines.every(({ text }) => {
    const letters = text.replace(/[^\p{L}]/gu, '')
    if (!letters) return true
    const result = eld.detect(text)
    if (normalizeChinese) {
      // Han alone is shared with Japanese. Kana, foreign words and confident Japanese
      // detections must remain translatable, even on a mostly Chinese screenshot.
      if (!/^\p{Script=Han}+$/u.test(letters)) return false
      if (result.language && result.language !== 'zh' && result.isReliable()) return false
      return normalizeChinese(text) === text
    }
    if (!(scripts[target] ?? /^\p{Script=Latin}+$/u).test(letters)) return false
    if (target === 'ko' || target === 'th' || (target === 'ja' && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(letters))) return true
    return result.language === target && result.isReliable()
  })
}
