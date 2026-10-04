import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'
import { encryptSecret, isMasked, maskSecret } from './secrets'

const SECRETS = ['apiKey', 'openaiKey'] as const

type Listener = (next: Settings, prev: Settings) => void

class SettingsStore {
  private data: Settings = { ...DEFAULT_SETTINGS }
  private file = ''
  private listeners = new Set<Listener>()

  load() {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'settings.json')
    if (existsSync(this.file)) {
      try {
        this.data = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(this.file, 'utf8')) }
      } catch {
        this.data = { ...DEFAULT_SETTINGS }
      }
      // 旧版本明文保存的 Key 迁移为加密
      const migrated = SECRETS.some((k) => this.data[k] && this.data[k] !== encryptSecret(this.data[k]))
      for (const k of SECRETS) this.data[k] = encryptSecret(this.data[k])
      if (migrated) writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    }
    return this.data
  }

  /** 给界面用：Key 打码 */
  public(): Settings {
    const s = { ...this.data }
    for (const k of SECRETS) s[k] = maskSecret(s[k])
    return s
  }

  get(): Settings {
    return this.data
  }

  update(patch: Partial<Settings>): Settings {
    const prev = this.data
    patch = { ...patch }
    for (const k of SECRETS) {
      const v = patch[k]
      if (v === undefined) continue
      // 界面回传的打码值表示未修改
      if (isMasked(v)) delete patch[k]
      else patch[k] = encryptSecret(v.trim())
    }
    this.data = { ...prev, ...patch }
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    for (const l of this.listeners) l(this.data, prev)
    return this.data
  }

  onChange(l: Listener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

export const settings = new SettingsStore()
