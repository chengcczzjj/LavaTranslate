import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { DEFAULT_SETTINGS, type Settings as S } from '../src/shared/types'
import { acceleratorLabel } from '../src/shared/hotkeys'

export async function checkSettingsHotkey(platform: 'Win32' | 'MacIntel') {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
  let saved: S = structuredClone(DEFAULT_SETTINGS)
  saved.hotkey = platform === 'MacIntel' ? 'Alt+Space' : 'Super+Space'
  const listeners = new Set<(s: S) => void>()
  const off = () => () => {}
  let rejectNext = false
  let surveyCalls = 0
  let updateOpens = 0
  Object.assign(window, { lens: {
    uiLang: () => 'zh-Hans', onUiLang: off,
    getSettings: async () => saved, onSettings: (cb: (s: S) => void) => { listeners.add(cb); return () => listeners.delete(cb) },
    appInfo: async () => ({ version: 'test' }), updateState: async () => ({ state: 'ready', version: '1.4.8', next: '1.4.9', manualInstall: platform === 'MacIntel' }), onUpdate: off,
    updateInstall: () => { updateOpens++ },
    engineStatus: async () => ({ ok: true }), ocrInfo: async () => 'CPU',
    suspendHotkey: async () => {}, onHotkeyRecorded: off,
    macSettingsStatus: async () => ({}),
    openOfflineSurvey: async () => {
      surveyCalls++
      if (surveyCalls === 1) return { ok: false }
      saved = { ...saved, offlineSurveyDismissed: true }
      for (const cb of listeners) cb(saved)
      return { ok: true }
    },
    setHotkey: async (hotkey: string) => {
      if (rejectNext) return { ok: false, message: 'hotkey.taken' }
      saved = { ...saved, hotkey }
      for (const cb of listeners) cb(saved)
      return { ok: true }
    }
  } })
  const { Settings } = await import('../src/renderer/src/settings/Settings')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20))
  const wait = async (f: () => boolean) => {
    for (let n = 0; n < 100; n++) { if (f()) return; await pause() }
    throw new Error(`Settings check timed out: ${host.textContent?.slice(0, 300)}`)
  }
  const keys = () => [...host.querySelectorAll('.hero-keys .keycap')].map((n) => n.textContent).join(' + ')
  const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
  const click = (selector: string) => { const el = host.querySelector<HTMLButtonElement>(selector); assert(el, selector); el!.click() }
  try {
    flushSync(() => root.render(<Settings />))
    await wait(() => !!host.querySelector('.hero-keys'))
    const label = (acc: string) => acceleratorLabel(acc, platform === 'MacIntel' ? 'darwin' : 'win32', 'zh-Hans')
    assert(keys() === label(saved.hotkey), 'home must show saved default')
    assert(host.querySelector('.offline-survey')?.textContent?.includes('1.13 GB'), 'survey must explain download size')
    click('.offline-survey button')
    await wait(() => !!host.querySelector('.offline-survey-error'))
    assert(!saved.offlineSurveyDismissed, 'failed submission must remain retryable')
    click('.offline-survey button')
    await wait(() => !host.querySelector('.offline-survey'))
    assert(saved.offlineSurveyDismissed && surveyCalls === 2, 'successful submission persists dismissal')
    click('[data-page="general"]')
    await wait(() => !!host.querySelector('.hotkey'))
    assert(!host.querySelector('.offline-survey'), 'survey stays hidden on the other settings page')
    click('.hotkey')
    await wait(() => !!host.querySelector('.hotkey.rec'))
    await pause()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'K', ctrlKey: true, shiftKey: true, bubbles: true }))
    await wait(() => saved.hotkey === 'Ctrl+Shift+K' && !host.querySelector('.hotkey.rec'))
    click('[data-page="home"]')
    await wait(() => !!host.querySelector('.hero-keys'))
    assert(keys() === label('Ctrl+Shift+K'), 'home did not update after saving custom shortcut')
    rejectNext = true
    click('[data-page="general"]')
    await wait(() => !!host.querySelector('.hotkey'))
    click('.hotkey')
    await wait(() => !!host.querySelector('.hotkey.rec'))
    await pause()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'J', ctrlKey: true, bubbles: true }))
    await wait(() => !!host.querySelector('.hk-hint.err'))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))
    click('[data-page="home"]')
    await wait(() => !!host.querySelector('.hero-keys'))
    assert(keys() === label('Ctrl+Shift+K'), 'failed shortcut must not change the home hint')
    click('[data-page="about"]')
    await wait(() => !!host.querySelector('.update-card.ready button'))
    const button = host.querySelector('.update-card.ready button')!
    assert(button.textContent?.includes(platform === 'MacIntel' ? '查看更新包' : '重启'), 'update action must match install mode')
    assert(!host.textContent?.includes('Mac 预览版'), 'packaged Mac is not unconditionally labeled a preview')
    if (platform === 'MacIntel') assert(host.querySelector('.update-card')?.textContent?.includes('Finder'), 'Mac must explain the installation step')
    click('.update-card.ready button')
    assert(updateOpens === 1, 'update action must reach the main process')
    return `${platform}: shortcut synchronization, survey retry/dismissal and update install mode`
  } finally { root.unmount(); host.remove() }
}

Object.assign(window, { checkSettingsHotkey })
