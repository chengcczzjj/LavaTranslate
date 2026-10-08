// 渲染进程的界面文字：语言由主进程决定（设置里的 uiLang，'auto' 跟随系统），切换后各窗口即时更新
import { Fragment, useSyncExternalStore, type ReactNode } from 'react'
import { langName, providerName, providerText, translator, type MsgKey, type Vars } from '@shared/i18n'

// 安卓版的手机网页也用到回复框等组件，那里没有 window.lens：界面固定简体中文
const lens = (window as Partial<Window>).lens
let lang = lens?.uiLang() ?? 'zh-Hans'
const subs = new Set<() => void>()

function apply() {
  // 字体按语言挑字形（日文、韩文、繁体中文各用本地字体），见 base.css
  if (lens) document.documentElement.lang = lang
}
apply()
lens?.onUiLang((l) => {
  lang = l
  apply()
  for (const f of subs) f()
})

const subscribe = (f: () => void) => {
  subs.add(f)
  return () => {
    subs.delete(f)
  }
}

export interface I18n {
  lang: string
  t: (key: MsgKey, vars?: Vars) => string
  /** 带组件的占位符：rich('ov.hintAlt', { k: <kbd>Alt</kbd> }) */
  rich: (key: MsgKey, nodes: Record<string, ReactNode>) => ReactNode
  /** 语言名称（界面语言写的）；inline 用在句子中间 */
  langLabel: (code: string, fallback?: string, inline?: boolean) => string
  provider: (id: string) => string
  providerText: (id: string) => ReturnType<typeof providerText>
  /** 简体中文界面：显示「国内直连 / 需要代理」这类只对国内网络有意义的提示 */
  zh: boolean
}

const cache = new Map<string, I18n>()

export function i18nFor(l: string): I18n {
  let v = cache.get(l)
  if (v) return v
  const t = translator(l)
  v = {
    lang: l,
    t,
    rich: (key, nodes) =>
      t(key)
        .split(/(\{\w+\})/)
        .map((part, i) => {
          const m = /^\{(\w+)\}$/.exec(part)
          return <Fragment key={i}>{m && m[1] in nodes ? nodes[m[1]] : part}</Fragment>
        }),
    langLabel: (code, fallback, inline) => langName(code, l, fallback, inline),
    provider: (id) => providerName(id, l),
    providerText: (id) => providerText(id, l),
    zh: l === 'zh-Hans'
  }
  cache.set(l, v)
  return v
}

/** 组件里用：语言切换时重新渲染 */
export function useI18n(): I18n {
  return i18nFor(useSyncExternalStore(subscribe, () => lang))
}

/** 组件外（回调、计时器）用当前语言 */
export function currentI18n(): I18n {
  return i18nFor(lang)
}
