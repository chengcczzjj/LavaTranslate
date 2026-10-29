import { macAcceleratorLabel } from './i18n/mac'

export function acceleratorLabel(value: string, platform: string, lang: string): string {
  if (platform === 'darwin') return macAcceleratorLabel(value)
  const space = lang === 'zh-Hant' ? '空白鍵' : lang.startsWith('zh') ? '空格' : 'Space'
  const keys: Record<string, string> = { Super: 'Win', Meta: 'Win', Space: space, CommandOrControl: 'Ctrl' }
  return value.split('+').map((key) => keys[key] ?? key).join(' + ')
}
