import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, providerForUrl, type ProviderConfig, type ProviderId, type Settings, type SettingsPatch } from '../shared/types'
import { encryptSecret, isMasked, maskSecret } from './secrets'

type Listener = (next: Settings, prev: Settings) => void

const EMPTY: ProviderConfig = { key: '', baseUrl: '', model: '' }

/**
 * 旧版设置（engine + apiKey / openaiKey…）转成按服务商保存的结构。
 * 已加密的 Key 原样搬过去：同一个数据目录，照样能解密
 */
function migrate(raw: any): { data: Settings; changed: boolean } {
  if (raw.providers && raw.provider) return { data: { ...DEFAULT_SETTINGS, ...raw }, changed: false }
  const providers: Settings['providers'] = { ...(raw.providers ?? {}) }
  let provider: ProviderId = DEFAULT_SETTINGS.provider
  if (raw.openaiKey || raw.openaiBaseUrl) {
    const id = raw.openaiBaseUrl ? providerForUrl(raw.openaiBaseUrl) : 'openai'
    providers[id] = { key: raw.openaiKey ?? '', baseUrl: id === 'custom' ? (raw.openaiBaseUrl ?? '') : '', model: raw.openaiModel ?? '' }
    if (raw.engine === 'openai') provider = id
  }
  if (raw.apiKey) {
    providers.claude = { key: raw.apiKey, baseUrl: raw.apiBaseUrl ?? '', model: /^claude/.test(raw.model ?? '') ? raw.model : '' }
    if (raw.engine === 'api') provider = 'claude'
  }
  const data: any = { ...DEFAULT_SETTINGS, ...raw, provider, providers }
  for (const k of ['engine', 'model', 'apiKey', 'apiBaseUrl', 'openaiKey', 'openaiBaseUrl', 'openaiModel', 'openaiSource']) delete data[k]
  return { data, changed: true }
}

class SettingsStore {
  private data: Settings = { ...DEFAULT_SETTINGS }
  private file = ''
  private listeners = new Set<Listener>()

  load() {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'settings.json')
    if (existsSync(this.file)) {
      let changed = false
      try {
        ;({ data: this.data, changed } = migrate(JSON.parse(readFileSync(this.file, 'utf8'))))
      } catch {
        // 文件损坏：另存一份再用默认设置，里面的设置和登录还有机会找回，不被下一次保存悄悄覆盖
        try {
          copyFileSync(this.file, `${this.file}.broken-${Date.now()}`)
        } catch {
          /* 忽略 */
        }
        this.data = { ...DEFAULT_SETTINGS }
      }
      // 明文保存的 Key（旧版或手工写入）改为加密
      for (const [id, c] of Object.entries(this.data.providers)) {
        if (c?.key && c.key !== encryptSecret(c.key)) {
          this.data.providers[id as ProviderId] = { ...c, key: encryptSecret(c.key) }
          changed = true
        }
      }
      if (changed) this.write()
    }
    return this.data
  }

  /** 先写临时文件再改名替换：写到一半被结束（安装更新、关机）时，原文件仍然完整 */
  private write() {
    const json = JSON.stringify(this.data, null, 2)
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, json, { flush: true })
    try {
      renameSync(tmp, this.file)
    } catch {
      // 杀毒软件等临时占用文件时改名会失败：退回直接覆盖
      writeFileSync(this.file, json)
      rmSync(tmp, { force: true })
    }
  }

  /** 给界面用：Key 打码 */
  public(): Settings {
    const providers: Settings['providers'] = {}
    for (const [id, c] of Object.entries(this.data.providers)) if (c) providers[id as ProviderId] = { ...c, key: maskSecret(c.key) }
    return { ...this.data, providers }
  }

  get(): Settings {
    return this.data
  }

  /** 当前服务（或指定服务）的配置，Key 仍是加密形式 */
  providerConfig(id: ProviderId = this.data.provider): ProviderConfig {
    return { ...EMPTY, ...this.data.providers[id] }
  }

  /** providers 按服务商逐项合并；界面回传的打码 Key 表示未修改 */
  update(patch: SettingsPatch): Settings {
    const prev = this.data
    const { providers: pp, ...rest } = patch
    const providers = { ...prev.providers }
    for (const [id, c] of Object.entries(pp ?? {})) {
      if (!c) continue
      const next: ProviderConfig = { ...EMPTY, ...providers[id as ProviderId], ...c }
      if (c.key !== undefined) next.key = isMasked(c.key) ? (providers[id as ProviderId]?.key ?? '') : encryptSecret(c.key.trim())
      if (c.baseUrl !== undefined) next.baseUrl = c.baseUrl.trim()
      providers[id as ProviderId] = next
    }
    this.data = { ...prev, ...rest, providers }
    this.write()
    for (const l of this.listeners) l(this.data, prev)
    return this.data
  }

  onChange(l: Listener) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

export const settings = new SettingsStore()
