// 凭据：当前翻译服务的接口地址、Key（解密后）、模型；识别 Key 属于哪家；从本机 Codex / CC Switch 导入现成的 Key
import { net } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AMBIGUOUS_KEY_PROVIDERS, providerByKeyFormat, providerInfo, type ProviderId, type ProviderInfo, type Settings } from '../shared/types'
import type { ChatGPTSession } from './chatgpt'
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

/** ChatGPT 登录信息（加密存放在 providers.chatgpt.key 里） */
export function chatgptSession(s: Settings): ChatGPTSession | null {
  try {
    const raw = decryptSecret(s.providers.chatgpt?.key ?? '')
    return raw ? (JSON.parse(raw) as ChatGPTSession) : null
  } catch {
    return null
  }
}

/** 当前服务的可用凭据；没填 Key（或自定义服务没填地址）时返回 null */
export function resolveProvider(s: Settings, id = s.provider): ResolvedProvider | null {
  const info = providerInfo(id)
  const c = s.providers[info.id]
  const apiKey = info.id === 'chatgpt' ? (chatgptSession(s)?.accessToken ?? '') : decryptSecret(c?.key ?? '').trim()
  const baseURL = (c?.baseUrl || info.baseUrl).trim().replace(/\/+$/, '')
  if (!apiKey || !baseURL) return null
  return { info, baseURL, apiKey, model: c?.model ?? '' }
}

export type KeyDetection = { provider: ProviderId; by: 'format' | 'probe' } | { provider: null; tried: ProviderId[] }

/**
 * 识别 Key 属于哪家：先看格式（AIza → Gemini、sk-ant- → Claude…）；
 * sk- 开头的几家格式一样，就依次请求它们的模型列表，能通过的就是
 */
export async function detectProvider(key: string): Promise<KeyDetection> {
  const k = key.trim()
  const byFormat = providerByKeyFormat(k)
  if (byFormat) return { provider: byFormat, by: 'format' }
  const tries = await Promise.all(
    AMBIGUOUS_KEY_PROVIDERS.map(async (id) => {
      try {
        const res = await net.fetch(`${providerInfo(id).baseUrl}/models`, { headers: { authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(8000) })
        return res.ok ? id : null
      } catch {
        return null
      }
    })
  )
  const hit = tries.find(Boolean)
  return hit ? { provider: hit, by: 'probe' } : { provider: null, tried: AMBIGUOUS_KEY_PROVIDERS }
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
