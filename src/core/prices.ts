// 模型价格查询与排序（价格表来自 models.dev；桌面在主进程里缓存刷新，安卓用安装包内置的快照）

/** [输入 $/百万 token, 输出 $/百万 token, 是否支持图片输入] */
export type PriceEntry = [number, number, number]
export type PriceTable = Record<string, PriceEntry>

export interface ModelPrice {
  id: string
  /** $ / 百万输入 token */
  input: number | null
  output: number | null
  vision: boolean | null
  /** 估算一次截图翻译的费用（$）：约 1500 输入 + 700 输出 token */
  perCall: number | null
}

export function priceIn(t: PriceTable, id: string): ModelPrice {
  const base = id.split('/').pop()!.toLowerCase()
  // 兼容带日期后缀、":free" 之类的变体名
  const e = t[base] ?? t[base.replace(/[-_]\d{4}-?\d{2}-?\d{2}$/, '')] ?? t[base.replace(/:.*$/, '')]
  if (!e) return { id, input: null, output: null, vision: null, perCall: null }
  return { id, input: e[0], output: e[1], vision: !!e[2], perCall: (1500 * e[0] + 700 * e[1]) / 1e6 }
}

/** 价格从低到高；没有价格信息的排在最后 */
export function sortByPriceIn(t: PriceTable, ids: string[]): ModelPrice[] {
  return ids.map((id) => priceIn(t, id)).sort((a, b) => (a.perCall ?? Infinity) - (b.perCall ?? Infinity) || a.id.localeCompare(b.id))
}
