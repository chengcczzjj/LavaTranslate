// 凭据来源：
//  1. Claude Code 登录（订阅额度）—— 由 Agent SDK 启动的 Claude Code 进程自行读取
//  2. API 模式 —— 设置里填写的 Key，或自动读取 Claude Code 的 ~/.claude/settings.json(env)
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '../shared/types'
import { decryptSecret } from './secrets'

export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function readJson(path: string): any {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch {
    return null
  }
}

export interface ApiCredentials {
  baseURL?: string
  apiKey?: string
  authToken?: string
  source: 'custom' | 'claude-code' | 'env'
}

export function resolveApiCredentials(s: Settings): ApiCredentials | null {
  const key = decryptSecret(s.apiKey).trim()
  if (key) return withKey(key, s.apiBaseUrl.trim() || undefined, 'custom')
  const env = readJson(join(claudeConfigDir(), 'settings.json'))?.env ?? {}
  const ccKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY
  if (ccKey) return withKey(ccKey, env.ANTHROPIC_BASE_URL || undefined, 'claude-code')
  const pKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
  if (pKey) return withKey(pKey, process.env.ANTHROPIC_BASE_URL || undefined, 'env')
  return null
}

function withKey(key: string, baseURL: string | undefined, source: ApiCredentials['source']): ApiCredentials {
  // 官方 Key 走 x-api-key；第三方中转通常两种头都认，一并带上
  if (key.startsWith('sk-ant-')) return { baseURL, apiKey: key, source }
  return { baseURL, apiKey: key, authToken: key, source }
}

export interface LoginStatus {
  loggedIn: boolean
  expired: boolean
  subscription?: string
}

/** 只读取到期时间判断登录状态，不读取令牌本身 */
export function claudeLoginStatus(): LoginStatus {
  const cred = readJson(join(claudeConfigDir(), '.credentials.json'))?.claudeAiOauth
  if (!cred) return { loggedIn: false, expired: false }
  const now = Date.now()
  const refreshExp = typeof cred.refreshTokenExpiresAt === 'number' ? cred.refreshTokenExpiresAt : Infinity
  return { loggedIn: true, expired: refreshExp < now, subscription: cred.subscriptionType }
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

export function resolveOpenAICredentials(s: Settings): OpenAICredentials | null {
  const key = decryptSecret(s.openaiKey).trim()
  if (!key) return null
  return { baseURL: s.openaiBaseUrl.trim() || 'https://api.openai.com/v1', apiKey: key, label: '已配置' }
}
