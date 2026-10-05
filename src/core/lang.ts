import { LANGUAGES, type Language } from '../shared/types'

/** 把模型识别出的语言代码对应到语言表；表里没有的直接用代码与模型给的名字 */
export function langFor(code: string, name?: string): Language {
  const c = code.toLowerCase()
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === c)
  if (exact) return exact
  if (c.startsWith('zh')) return LANGUAGES.find((l) => l.code === (/(tw|hk|hant|mo)/.test(c) ? 'zh-Hant' : 'zh-Hans'))!
  const base = LANGUAGES.find((l) => l.code === c.split('-')[0])
  return base ?? { code, name: name ?? code, native: name ?? code }
}
