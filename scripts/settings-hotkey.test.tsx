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
  Object.assign(window, { lens: {
    uiLang: () => 'zh-Hans', onUiLang: off,
    getSettings: async () => saved, onSettings: (cb: (s: S) => void) => { listeners.add(cb); return () => listeners.delete(cb) },
    appInfo: async () => ({ version: 'test' }), updateState: async () => ({ state: 'idle' }), onUpdate: off,
    engineStatus: async () => ({ ok: true }), ocrInfo: async () => 'CPU',
    suspendHotkey: async () => {}, onHotkeyRecorded: off,
    macSettingsStatus: async () => ({}),
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
    click('[data-page="general"]')
    await wait(() => !!host.querySelector('.hotkey'))
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
    return `${platform}: saved shortcut updates home; rejected shortcut keeps previous hint`
  } finally { root.unmount(); host.remove() }
}

Object.assign(window, { checkSettingsHotkey })
