// 手机版设置结构与翻译引擎（引擎本身与桌面版共用 core/translator.ts）
import { OpenAIEngine } from '@core/translator'
import { providerInfo, type ProviderConfig, type ProviderId, type ProviderInfo } from '@shared/types'

export interface MobileSettings {
  targetLang: string
  provider: ProviderId
  providers: Partial<Record<ProviderId, ProviderConfig>>
  replyAssist: boolean
  replyTone: 'auto' | 'formal' | 'casual'
  styleHint: string
  /** projection：系统截屏授权（每次会话授权一次）；accessibility：无障碍免授权 */
  captureMode: 'projection' | 'accessibility'
  bubbleEnabled: boolean
  bubbleSide: 'left' | 'right'
  bubbleY: number
  firstRunDone: boolean
  /** 自动检查更新（Wi-Fi 下自动下载） */
  autoUpdate: boolean
}

export interface Resolved {
  info: ProviderInfo
  baseURL: string
  apiKey: string
  model: string
}

/** 当前服务的可用凭据（设置需含明文 Key）；没填 Key 或自定义服务没填地址时返回 null */
export function resolveProvider(s: MobileSettings, id: ProviderId = s.provider): Resolved | null {
  const info = providerInfo(id)
  const c = s.providers[info.id]
  const apiKey = (c?.key ?? '').trim()
  const baseURL = (c?.baseUrl || info.baseUrl).trim().replace(/\/+$/, '')
  if (!apiKey || !baseURL) return null
  return { info, baseURL, apiKey, model: c?.model ?? '' }
}

export function engineProblem(s: MobileSettings): string | null {
  const info = providerInfo(s.provider)
  const r = resolveProvider(s)
  if (!r) return info.id === 'custom' && s.providers.custom?.key ? '还没有填写接口地址' : '还没有填写 API Key'
  if (!r.model) return `${info.name} · 请选择一个模型`
  return null
}

// 同一组配置复用同一个引擎：它会记住该服务用哪种接口、支持哪档推理强度
const cache = new Map<string, OpenAIEngine>()

export function engineFor(s: MobileSettings): OpenAIEngine | null {
  const r = resolveProvider(s)
  if (!r || !r.model) return null
  const key = [r.info.id, r.baseURL, r.model, r.apiKey].join('|')
  let e = cache.get(key)
  if (!e) {
    cache.clear()
    e = new OpenAIEngine({ baseURL: r.baseURL, apiKey: r.apiKey }, r.model, { api: r.info.api, chatExtra: r.info.chatExtra })
    cache.set(key, e)
  }
  return e
}
