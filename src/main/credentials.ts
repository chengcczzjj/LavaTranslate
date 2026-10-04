// 凭据：当前翻译服务的接口地址、Key（解密后）、模型；另可从本机 Codex / CC Switch 导入现成的 Key
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { providerInfo, type ProviderInfo, type Settings } from '../shared/types'
import { decryptSecret } from './secrets'

function readJson(path: string): any {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch {
    return null
  }
}

export interface ResolvedProvider {
  info: ProviderInfo
  baseURL: string
  apiKey: string
  model: string
}

/** 当前服务的可用凭据；没填 Key（或自定义服务没填地址）时返回 null */
export function resolveProvider(s: Settings, id = s.provider): ResolvedProvider | null {
  const info = providerInfo(id)
  const c = s.providers[info.id]
  const apiKey = decryptSecret(c?.key ?? '').trim()
  const baseURL = (c?.baseUrl || info.baseUrl).trim().replace(/\/+$/, '')
  if (!apiKey || (info.protocol === 'openai' && !baseURL)) return null
  return { info, baseURL, apiKey, model: c?.model ?? '' }
}

// ------------------------------------------------------------------ OpenAI 兼容（Codex）
export interface OpenAICredentials {
  baseURL: string
  apiKey: string
  /** 配置里写的默认模型 */
  model?: string
  label: string
}

/** 解析 Codex 的 config.toml 片段：当前 provider 的 base_url / bearer token / env_key */
function parseCodexToml(toml: string): { baseURL?: string; token?: string; envKey?: string; model?: string; name?: string } {
  // 只需要顶层键和 [model_providers.xxx] 段里的字符串值，逐行解析即可
  const sections = new Map<string, Record<string, string>>()
  let cur = ''
  sections.set(cur, {})
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim()
    const head = line.match(/^\[([^\]]+)\]$/)
    if (head) {
      cur = head[1].trim()
      if (!sections.has(cur)) sections.set(cur, {})
      continue
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*["'](.*)["']\s*$/)
    if (kv) sections.get(cur)![kv[1]] = kv[2]
  }
  const top = sections.get('')!
  const provider = top.model_provider
  if (!provider) return { model: top.model }
  const sec = sections.get(`model_providers.${provider}`) ?? sections.get(`model_providers."${provider}"`) ?? {}
  return {
    baseURL: sec.base_url,
    token: sec.experimental_bearer_token,
    envKey: sec.env_key,
    name: sec.name ?? provider,
    model: top.model
  }
}

function codexDir() {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

/** 列出本机可用的 OpenAI 兼容凭据：~/.codex 当前配置 + CC Switch 里保存的 Codex 供应商 */
export function findOpenAISources(): (OpenAICredentials & { id: string })[] {
  const out: (OpenAICredentials & { id: string })[] = []
  // 1. ~/.codex
  try {
    const toml = existsSync(join(codexDir(), 'config.toml')) ? readFileSync(join(codexDir(), 'config.toml'), 'utf8') : ''
    const auth = readJson(join(codexDir(), 'auth.json'))
    const c = parseCodexToml(toml)
    const key = c.token || (c.envKey ? process.env[c.envKey] : undefined) || auth?.OPENAI_API_KEY
    if (key) out.push({ id: 'codex', label: `Codex 当前配置${c.name ? ` · ${c.name}` : ''}`, baseURL: c.baseURL || 'https://api.openai.com/v1', apiKey: key, model: c.model })
  } catch {
    /* 忽略 */
  }
  // 2. CC Switch
  try {
    const dbPath = join(homedir(), '.cc-switch', 'cc-switch.db')
    if (existsSync(dbPath)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const rows = db.prepare("select name, settings_config from providers where app_type = 'codex'").all() as { name: string; settings_config: string }[]
      db.close()
      for (const r of rows) {
        let conf: any = {}
        try {
          conf = JSON.parse(r.settings_config)
        } catch {
          continue
        }
        const c = parseCodexToml(conf.config ?? '')
        const key = c.token || conf.auth?.OPENAI_API_KEY
        if (!key) continue
        if (out.some((o) => o.apiKey === key)) continue
        out.push({ id: `ccs:${r.name}`, label: `CC Switch · ${r.name}`, baseURL: c.baseURL || 'https://api.openai.com/v1', apiKey: key, model: c.model })
      }
    }
  } catch {
    /* 没有 node:sqlite 或数据库被占用 */
  }
  return out
}
