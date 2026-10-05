// 模型价格：来自 models.dev（各家模型的公开价格库），联网获取后缓存 3 天；离线时用安装包内置的快照
import { app, net } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { priceIn, sortByPriceIn, type ModelPrice, type PriceEntry as Entry } from '../core/prices'

const TTL = 3 * 24 * 3600 * 1000
const OFFICIAL = ['openai', 'anthropic', 'deepseek', 'zai', 'zhipuai', 'alibaba', 'moonshotai', 'google', 'xai', 'mistral', 'minimax']

let table: Record<string, Entry> | null = null
let refreshing: Promise<void> | null = null

function cacheFile() {
  return join(app.getPath('userData'), 'model-prices.json')
}

function load(bundled: string) {
  if (table) return table
  for (const f of [cacheFile(), bundled]) {
    try {
      if (existsSync(f)) {
        table = JSON.parse(readFileSync(f, 'utf8'))
        break
      }
    } catch {
      /* 换下一个 */
    }
  }
  return (table ??= {})
}

/** 由 models.dev 原始数据生成精简表：官方渠道价格优先，否则取各渠道中位数 */
function compact(json: Record<string, { models?: Record<string, any> }>) {
  const acc = new Map<string, { offs: [number, [number, number]][]; all: [number, number][]; vision: boolean }>()
  for (const [prov, p] of Object.entries(json)) {
    for (const [id, m] of Object.entries(p.models ?? {})) {
      const c = m.cost
      if (!c || !(c.input > 0 || c.output > 0)) continue
      const key = id.split('/').pop()!.toLowerCase()
      const e = acc.get(key) ?? { offs: [], all: [], vision: false }
      const item: [number, number] = [c.input ?? 0, c.output ?? 0]
      if (OFFICIAL.includes(prov)) e.offs.push([OFFICIAL.indexOf(prov), item])
      e.all.push(item)
      if (m.modalities?.input?.includes('image')) e.vision = true
      acc.set(key, e)
    }
  }
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]
  const out: Record<string, Entry> = {}
  for (const [k, e] of acc) {
    const pick = e.offs.length ? e.offs.sort((a, b) => a[0] - b[0])[0][1] : [med(e.all.map((x) => x[0])), med(e.all.map((x) => x[1]))]
    out[k] = [+pick[0].toFixed(4), +pick[1].toFixed(4), e.vision ? 1 : 0]
  }
  return out
}

/** 缓存过期则后台刷新 */
export function refreshPrices(bundled: string) {
  load(bundled)
  const f = cacheFile()
  const fresh = existsSync(f) && Date.now() - statSync(f).mtimeMs < TTL
  if (fresh || refreshing) return refreshing ?? Promise.resolve()
  refreshing = (async () => {
    try {
      const res = await net.fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) return
      const out = compact((await res.json()) as Record<string, { models?: Record<string, any> }>)
      if (Object.keys(out).length > 100) {
        table = out
        writeFileSync(f, JSON.stringify(out))
      }
    } catch {
      /* 离线：继续用旧表 */
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export type { ModelPrice }

export function priceOf(id: string, bundled: string): ModelPrice {
  return priceIn(load(bundled), id)
}

/** 价格从低到高；没有价格信息的排在最后 */
export function sortByPrice(ids: string[], bundled: string): ModelPrice[] {
  return sortByPriceIn(load(bundled), ids)
}
