// 主进程的界面文字：托盘菜单、通知、对话框、错误提示
import { app } from 'electron'
import { resolveUiLang, translator, type MsgKey, type UiLang, type Vars } from '../shared/i18n'
import { TranslateError } from '../core/translator'
import { settings } from './settings'

/** 当前界面语言（设置为「跟随系统」时取 Windows 的显示语言） */
export function uiLang(): UiLang {
  return resolveUiLang(settings.get().uiLang, app.getPreferredSystemLanguages())
}

export function t(key: MsgKey, vars?: Vars) {
  return translator(uiLang())(key, vars)
}

/** 错误显示给用户：翻译引擎的错误带词条时按界面语言显示 */
export function errorText(e: unknown) {
  if (e instanceof TranslateError && e.msg) return t(e.msg.id as MsgKey, e.msg.vars)
  return e instanceof Error ? e.message : String(e)
}
