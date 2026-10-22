import { translator, type Messages, type T } from './index'

// 只由 Mac 桌面入口使用，其他平台继续使用原词条。
const zh: Partial<Messages> = {
  'gen.hotkeyDesc': '按一次开始框选，连续按两次进入输入翻译。默认快捷键为 ⌥ Option + Space。',
  'gen.launch': '登录时打开',
  'gen.launchDesc': '登录 Mac 后在菜单栏运行；可在「系统设置 → 通用 → 登录项」中管理。',
  'hotkey.needMod': '至少包含一个修饰键（⌘ Command / ⌥ Option / ⌃ Control / ⇧ Shift）',
  'sc.tray': '菜单栏图标',
  'sc.trayDo': '选择「设置」，或按 ⌘ ,',
  'notify.updateReadyBody': 'v{v} 已就绪，可从菜单栏重启更新。',
  'upd.title.disabled': 'Mac 预览版 · 手动更新',
  'upd.short.dev': 'Mac 预览版',
  'about.privacyDesc': '文字识别在 Mac 本机完成。所选区域的图像、识别文字及你输入的回复会发送至所配置的翻译服务；API Key 加密保存在本机，应用不保存翻译历史。'
}
const zhHant: Partial<Messages> = {
  ...zh,
  'gen.hotkeyDesc': '按一次開始框選，連續按兩次進入輸入翻譯。預設快速鍵為 ⌥ Option + Space。',
  'gen.launch': '登入時打開',
  'gen.launchDesc': '登入 Mac 後在選單列執行；可在「系統設定 → 一般 → 登入項目與延伸功能」中管理。',
  'hotkey.needMod': '至少包含一個變更鍵（⌘ Command / ⌥ Option / ⌃ Control / ⇧ Shift）',
  'sc.tray': '選單列圖像',
  'sc.trayDo': '選擇「設定」，或按 ⌘ ,',
  'notify.updateReadyBody': 'v{v} 已就緒，可從選單列重新啟動更新。',
  'upd.title.disabled': 'Mac 預覽版 · 手動更新',
  'upd.short.dev': 'Mac 預覽版',
  'about.privacyDesc': '文字辨識在 Mac 本機完成。所選區域的影像、辨識文字及你輸入的回覆會傳送至設定的翻譯服務；API Key 加密儲存在本機，App 不儲存翻譯記錄。'
}
const en: Partial<Messages> = {
  'gen.hotkeyDesc': 'Press once to select an area, or twice to translate typed text. Default: ⌥ Option + Space.',
  'gen.launch': 'Open at login',
  'gen.launchDesc': 'Run in the menu bar when you log in. Manage in System Settings → General → Login Items.',
  'hotkey.needMod': 'Include a modifier: ⌘ Command / ⌥ Option / ⌃ Control / ⇧ Shift',
  'sc.tray': 'Menu bar icon',
  'sc.trayDo': 'Choose Settings, or press ⌘ ,',
  'notify.updateReadyBody': 'v{v} is ready. Restart from the menu bar to update.',
  'upd.title.disabled': 'Mac preview · Manual updates',
  'upd.short.dev': 'Mac preview',
  'about.privacyDesc': 'Text recognition runs on your Mac. Selected images, recognized text and typed replies are sent to your configured service. API keys are encrypted locally; the app does not save translation history.'
}

const cache = new Map<string, T>()
export function macTranslator(lang: string): T {
  const cached = cache.get(lang)
  if (cached) return cached
  const base = translator(lang)
  const overrides = lang === 'zh-Hans' ? zh : lang === 'zh-Hant' ? zhHant : lang === 'en' ? en : {}
  const t: T = (key, vars) => {
    let text = (overrides[key] ?? (key === 'sc.tray' ? '⌘ ,' : base(key))).replace(/\bAlt\b/g, 'Option').replace(/\bCtrl\b/g, 'Command').replace(/Windows/g, 'macOS').replace(/Option\+Q Q/g, '⌥ Space × 2')
    if (vars) for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value))
    return text
  }
  cache.set(lang, t)
  return t
}

/** 已保存的自定义快捷键要区分 Control 和 Command。 */
export function macAcceleratorLabel(value: string): string {
  const keys: Record<string, string> = { Alt: '⌥ Option', Option: '⌥ Option', Command: '⌘ Command', CommandOrControl: '⌘ Command', Ctrl: '⌃ Control', Control: '⌃ Control', Shift: '⇧ Shift' }
  return value.split('+').map((key) => keys[key] ?? key).join(' + ')
}
