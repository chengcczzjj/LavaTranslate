// 界面语言（桌面版）：托盘菜单、设置、截图界面、通知和错误提示。
// 设置里保存 uiLang（'auto' 跟随系统），主进程解析成下面的某一种再告诉各窗口。
// 加文字：先在 zh-Hans.ts 加词条，其他语言文件缺了会在类型检查时报错
import { providerInfo } from '../providers'
import zhHans, { type Messages, type MsgKey } from './zh-Hans'
import zhHant from './zh-Hant'
import en from './en'
import ja from './ja'
import ko from './ko'
import es from './es'
import fr from './fr'
import de from './de'
import pt from './pt'
import ru from './ru'
import it from './it'
import vi from './vi'

export type { MsgKey, Messages }

/** 菜单里按这个顺序列出，名称用各自的语言写 */
export const UI_LANGS = [
  { code: 'zh-Hans', native: '简体中文' },
  { code: 'zh-Hant', native: '繁體中文' },
  { code: 'en', native: 'English' },
  { code: 'ja', native: '日本語' },
  { code: 'ko', native: '한국어' },
  { code: 'es', native: 'Español' },
  { code: 'fr', native: 'Français' },
  { code: 'de', native: 'Deutsch' },
  { code: 'pt', native: 'Português' },
  { code: 'ru', native: 'Русский' },
  { code: 'it', native: 'Italiano' },
  { code: 'vi', native: 'Tiếng Việt' }
] as const

export type UiLang = (typeof UI_LANGS)[number]['code']

const DICTS: Record<UiLang, Messages> = { 'zh-Hans': zhHans, 'zh-Hant': zhHant, en, ja, ko, es, fr, de, pt, ru, it, vi }

/** 语言代码统一成 zh-hans / zh-hant / 主语言（en-US → en） */
export function langBase(code: string) {
  const c = code.toLowerCase()
  if (c.startsWith('zh')) return /(tw|hk|mo|hant)/.test(c) ? 'zh-hant' : 'zh-hans'
  return c.split(/[-_]/)[0]
}

/** 系统语言 → 支持的界面语言；都不支持时用英语 */
export function matchUiLang(locales: readonly string[]): UiLang {
  for (const l of locales) {
    const base = langBase(l)
    const hit = UI_LANGS.find((u) => u.code.toLowerCase() === base)
    if (hit) return hit.code
  }
  return 'en'
}

/** 设置值（'auto' 或某种语言）→ 实际使用的界面语言 */
export function resolveUiLang(pref: string | undefined, system: readonly string[]): UiLang {
  const hit = UI_LANGS.find((u) => u.code === pref)
  return hit ? hit.code : matchUiLang(system)
}

export type Vars = Record<string, string | number>
export type T = (key: MsgKey, vars?: Vars) => string

const cache = new Map<string, T>()

/** 某种界面语言的取词函数；缺的词条退回英语，再退回简体中文 */
export function translator(lang: string): T {
  let t = cache.get(lang)
  if (t) return t
  const dict: Partial<Messages> = DICTS[lang as UiLang] ?? en
  t = (key, vars) => {
    let s = dict[key] ?? en[key] ?? zhHans[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
    return s
  }
  cache.set(lang, t)
  return t
}

/** 动态拼出来的词条（服务商文字）：不存在时返回空字符串 */
export function has(lang: string, key: string): boolean {
  return !!(DICTS[lang as UiLang] ?? en)[key as MsgKey]
}

const names = new Map<string, Intl.DisplayNames | null>()

/**
 * 语言名称，用界面语言写（英语界面显示 Japanese，中文界面显示 日语）；拿不到时用 fallback。
 * inline：放在句子中间（法语等语言名小写）
 */
export function langName(code: string, ui: string, fallback?: string, inline = false): string {
  let dn = names.get(ui)
  if (dn === undefined) {
    try {
      dn = new Intl.DisplayNames([ui], { type: 'language', fallback: 'none' })
    } catch {
      dn = null
    }
    names.set(ui, dn)
  }
  const base = langBase(code)
  const norm = base === 'zh-hans' ? 'zh-Hans' : base === 'zh-hant' ? 'zh-Hant' : base
  try {
    const n = base === 'zh-hans' ? translator(ui)('lang.zhHans') : base === 'zh-hant' ? translator(ui)('lang.zhHant') : dn?.of(norm)
    if (n) return inline ? n : n.charAt(0).toLocaleUpperCase(ui) + n.slice(1)
  } catch {
    /* 不合法的代码 */
  }
  return fallback ?? code
}

/** 服务商名称：通义千问、智谱、豆包、自定义 在其他语言里另有写法 */
export function providerName(id: string, lang: string): string {
  const key = `prov.${id}.name`
  return has(lang, key) || has('en', key) ? translator(lang)(key as MsgKey) : providerInfo(id).name
}

/** 服务商的介绍、获取 Key 的步骤与提示（按界面语言） */
export function providerText(id: string, lang: string) {
  const tr = translator(lang)
  const get = (f: string) => (has(lang, `prov.${id}.${f}`) || has('en', `prov.${id}.${f}`) ? tr(`prov.${id}.${f}` as MsgKey) : '')
  return { blurb: get('blurb'), link: get('link'), steps: get('steps').split('\n').filter(Boolean), tip: get('tip') }
}
