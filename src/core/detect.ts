// 识别 API Key 属于哪家服务（桌面与安卓共用）
import { AMBIGUOUS_KEY_PROVIDERS, providerByKeyFormat, providerInfo, type ProviderId } from '../shared/providers'
import { pfetch } from './platform'

export type KeyDetection = { provider: ProviderId; by: 'format' | 'probe' } | { provider: null; tried: ProviderId[] }

/**
 * 识别 Key 属于哪家：先看格式（AIza → Gemini、sk-ant- → Claude…）；
 * sk- 开头的几家格式一样，就依次请求它们的模型列表，能通过的就是
 */
export async function detectProvider(key: string): Promise<KeyDetection> {
  const k = key.trim()
  const byFormat = providerByKeyFormat(k)
  if (byFormat) return { provider: byFormat, by: 'format' }
  // 哪家先通过就用哪家，不等其他几家（网络不通的那家要等到超时）
  const hit = await new Promise<ProviderId | null>((resolve) => {
    let left = AMBIGUOUS_KEY_PROVIDERS.length
    for (const id of AMBIGUOUS_KEY_PROVIDERS) {
      pfetch(`${providerInfo(id).baseUrl}/models`, { headers: { authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(8000) })
        .then((res) => res.ok)
        .catch(() => false)
        .then((ok) => {
          if (ok) resolve(id)
          else if (--left === 0) resolve(null)
        })
    }
  })
  return hit ? { provider: hit, by: 'probe' } : { provider: null, tried: AMBIGUOUS_KEY_PROVIDERS }
}
