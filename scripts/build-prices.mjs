// 从 models.dev 生成精简价格表 resources/model-prices.json（离线兜底；运行时会联网更新）
// 结构：{ "<model id>": [inputUSDPerM, outputUSDPerM, vision(0|1)] }
import { readFileSync, writeFileSync } from 'node:fs'

const src = process.argv[2]
const json = src ? JSON.parse(readFileSync(src, 'utf8')) : await (await fetch('https://models.dev/api.json')).json()
// 官方渠道优先，其次取各渠道非零价格的中位数
const OFFICIAL = ['openai', 'anthropic', 'deepseek', 'zai', 'zhipuai', 'alibaba', 'moonshotai', 'google', 'xai', 'mistral', 'minimax']
const acc = new Map()
for (const [prov, p] of Object.entries(json)) {
  for (const [id, m] of Object.entries(p.models ?? {})) {
    const c = m.cost
    if (!c || !(c.input > 0 || c.output > 0)) continue
    const key = id.split('/').pop().toLowerCase()
    const e = acc.get(key) ?? { offs: [], all: [], vision: false }
    const item = [c.input ?? 0, c.output ?? 0]
    if (OFFICIAL.includes(prov)) e.offs.push([OFFICIAL.indexOf(prov), item])
    e.all.push(item)
    if (m.modalities?.input?.includes('image')) e.vision = true
    acc.set(key, e)
  }
}
const med = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1]
const out = {}
for (const [k, e] of acc) {
  const pick = e.offs.length ? e.offs.sort((a, b) => a[0] - b[0])[0][1] : [med(e.all.map((x) => x[0])), med(e.all.map((x) => x[1]))]
  out[k] = [+pick[0].toFixed(4), +pick[1].toFixed(4), e.vision ? 1 : 0]
}
writeFileSync('resources/model-prices.json', JSON.stringify(out))
console.log('models', Object.keys(out).length)
