// PP-OCRv6 (small) 文字检测 + 识别，基于 onnxruntime-node（优先 DirectML GPU）
// 只做屏幕截图场景需要的部分：水平/竖排文字行，不做透视矫正
import * as ort from 'onnxruntime-node'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OcrLine, Rect } from '../shared/types'

export interface RgbaImage {
  data: Uint8Array
  width: number
  height: number
}

const DET_THRESH = 0.2
const DET_BOX_THRESH = 0.45
const DET_UNCLIP = 1.4
const DET_MAX_SIDE = 3200
const DET_PAD = 16 // 检测图四周留白（检测空间像素），防止贴边文字漏检
const REC_H = 48
const REC_MIN_W = 320

// 归一化查表：Paddle 按 BGR 通道顺序做 (x/255 - mean) / std
const DET_LUT = [0, 1, 2].map((c) => {
  const mean = [0.485, 0.456, 0.406][c]
  const std = [0.229, 0.224, 0.225][c]
  const t = new Float32Array(256)
  for (let v = 0; v < 256; v++) t[v] = (v / 255 - mean) / std
  return t
})
const REC_LUT = (() => {
  const t = new Float32Array(256)
  for (let v = 0; v < 256; v++) t[v] = v / 127.5 - 1
  return t
})()

interface Box {
  rect: Rect
  vertical: boolean
}

export class PaddleOcr {
  private det!: ort.InferenceSession
  private rec!: ort.InferenceSession
  private dict: string[] = []
  private ready: Promise<void> | null = null
  /** 识别模型是否已在图里做了 ArgMax（scripts/patch-rec.py） */
  private recArgmax = false
  /** 实际使用的推理后端 */
  provider: 'dml' | 'cpu' = 'cpu'
  /** 最近一次识别各阶段耗时（ms） */
  timing: Record<string, number> = {}

  constructor(private modelDir: string) {}

  init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        // 优先 DirectML（GPU），失败回退 CPU
        const create = async (ep: 'dml' | 'cpu') => {
          const opts: ort.InferenceSession.SessionOptions = {
            graphOptimizationLevel: 'all',
            executionProviders: [ep],
            logSeverityLevel: 3,
            ...(ep === 'cpu' ? { intraOpNumThreads: 4 } : {})
          }
          return Promise.all([
            ort.InferenceSession.create(join(this.modelDir, 'det.onnx'), opts),
            ort.InferenceSession.create(join(this.modelDir, 'rec.onnx'), opts)
          ])
        }
        try {
          ;[this.det, this.rec] = await create('dml')
          this.provider = 'dml'
        } catch {
          ;[this.det, this.rec] = await create('cpu')
          this.provider = 'cpu'
        }
        this.recArgmax = this.rec.outputNames.includes('best_idx')
        const lines = readFileSync(join(this.modelDir, 'rec_dict.txt'), 'utf8').split(/\r?\n/)
        if (lines[lines.length - 1] === '') lines.pop()
        // CTC: 0 = blank, 1..N = 字典, N+1 = 空格
        this.dict = ['', ...lines, ' ']
        // 预热几种常见尺寸，GPU 首次遇到新形状需要编译
        const warm = (w: number, h: number) => {
          const d = new Uint8Array(w * h * 4).fill(255)
          for (let y = (h / 2 - 6) | 0; y < h / 2 + 6; y++) for (let x = 20; x < w - 20; x += 3) d.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3)
          return this.run({ data: d, width: w, height: h })
        }
        await warm(640, 360)
        await warm(1280, 720)
      })()
    }
    return this.ready
  }

  async recognize(img: RgbaImage): Promise<OcrLine[]> {
    await this.init()
    return this.run(img)
  }

  private async run(img: RgbaImage): Promise<OcrLine[]> {
    const t0 = performance.now()
    const boxes = await this.detect(img)
    this.timing = { det: performance.now() - t0 }
    if (!boxes.length) return []
    const t1 = performance.now()
    const texts = await this.recognizeBoxes(img, boxes)
    this.timing.rec = performance.now() - t1
    // 低置信度的行也保留位置，由 Claude 看图补全（例如 OCR 不支持的韩文）
    return boxes.map((b, i) => ({
      id: i + 1,
      text: texts[i].text,
      score: +texts[i].score.toFixed(3),
      box: b.rect,
      vertical: b.vertical || undefined,
      cx: b.vertical ? undefined : texts[i].cx
    }))
  }

  // ---------------------------------------------------------------- 检测
  private async detect(img: RgbaImage): Promise<Box[]> {
    const { width: W, height: H, data } = img
    // 小图放大以提升细小文字的检出率；大图限制最长边
    let scale = Math.min(2, Math.max(1, 960 / Math.max(W, H)))
    scale = Math.min(scale, (DET_MAX_SIDE - DET_PAD * 2) / Math.max(W, H))
    const cw = Math.round(W * scale)
    const ch = Math.round(H * scale)
    const dw = Math.ceil((cw + DET_PAD * 2) / 32) * 32
    const dh = Math.ceil((ch + DET_PAD * 2) / 32) * 32
    const plane = dw * dh
    const input = new Float32Array(3 * plane)
    const [lb, lg, lr] = DET_LUT

    // 留白用边缘像素均值填充
    const bg = borderMean(img)
    input.fill(lb[bg[2]], 0, plane)
    input.fill(lg[bg[1]], plane, 2 * plane)
    input.fill(lr[bg[0]], 2 * plane, 3 * plane)

    if (cw === W && ch === H) {
      for (let y = 0; y < H; y++) {
        let s = y * W * 4
        let d = (y + DET_PAD) * dw + DET_PAD
        for (let x = 0; x < W; x++, s += 4, d++) {
          input[d] = lb[data[s + 2]]
          input[plane + d] = lg[data[s + 1]]
          input[2 * plane + d] = lr[data[s]]
        }
      }
    } else {
      const cols = axisTable(cw, W, 0, W)
      const rows = axisTable(ch, H, 0, H)
      for (let y = 0; y < ch; y++) {
        const r0 = rows.i0[y] * W
        const r1 = rows.i1[y] * W
        const ay = rows.a[y]
        let d = (y + DET_PAD) * dw + DET_PAD
        for (let x = 0; x < cw; x++, d++) {
          const ax = cols.a[x]
          const p00 = (r0 + cols.i0[x]) * 4
          const p10 = (r0 + cols.i1[x]) * 4
          const p01 = (r1 + cols.i0[x]) * 4
          const p11 = (r1 + cols.i1[x]) * 4
          const tR = data[p00] + (data[p10] - data[p00]) * ax
          const bR = data[p01] + (data[p11] - data[p01]) * ax
          const tG = data[p00 + 1] + (data[p10 + 1] - data[p00 + 1]) * ax
          const bG = data[p01 + 1] + (data[p11 + 1] - data[p01 + 1]) * ax
          const tB = data[p00 + 2] + (data[p10 + 2] - data[p00 + 2]) * ax
          const bB = data[p01 + 2] + (data[p11 + 2] - data[p01 + 2]) * ax
          input[d] = lb[(tB + (bB - tB) * ay + 0.5) | 0]
          input[plane + d] = lg[(tG + (bG - tG) * ay + 0.5) | 0]
          input[2 * plane + d] = lr[(tR + (bR - tR) * ay + 0.5) | 0]
        }
      }
    }

    const res = await this.det.run({ x: new ort.Tensor('float32', input, [1, 3, dh, dw]) })
    const prob = res[this.det.outputNames[0]].data as Float32Array

    // 积分图，用于 O(1) 求框内平均概率
    const iw = dw + 1
    const integ = new Float64Array(iw * (dh + 1))
    for (let y = 0; y < dh; y++) {
      let row = 0
      const o = y * dw
      const a = y * iw
      const b = (y + 1) * iw
      for (let x = 0; x < dw; x++) {
        row += prob[o + x]
        integ[b + x + 1] = integ[a + x + 1] + row
      }
    }

    // 8 邻域连通域
    const seen = new Uint8Array(plane)
    const stack = new Int32Array(plane)
    const boxes: Box[] = []
    for (let start = 0; start < plane; start++) {
      if (seen[start] || prob[start] <= DET_THRESH) continue
      let sp = 0
      stack[sp++] = start
      seen[start] = 1
      let minX = dw, minY = dh, maxX = 0, maxY = 0, area = 0
      while (sp) {
        const p = stack[--sp]
        const px = p % dw
        const py = (p - px) / dw
        area++
        if (px < minX) minX = px
        if (px > maxX) maxX = px
        if (py < minY) minY = py
        if (py > maxY) maxY = py
        const yA = py > 0 ? py - 1 : 0
        const yB = py < dh - 1 ? py + 1 : py
        const xA = px > 0 ? px - 1 : 0
        const xB = px < dw - 1 ? px + 1 : px
        for (let ny = yA; ny <= yB; ny++) {
          for (let nx = xA, q = ny * dw + xA; nx <= xB; nx++, q++) {
            if (!seen[q] && prob[q] > DET_THRESH) {
              seen[q] = 1
              stack[sp++] = q
            }
          }
        }
      }
      const bw = maxX - minX + 1
      const bh = maxY - minY + 1
      if (Math.min(bw, bh) < 3 || area < 6) continue
      const sum = integ[(maxY + 1) * iw + maxX + 1] - integ[minY * iw + maxX + 1] - integ[(maxY + 1) * iw + minX] + integ[minY * iw + minX]
      if (sum / (bw * bh) < DET_BOX_THRESH) continue
      // DB unclip：按面积/周长外扩
      const dd = (bw * bh * DET_UNCLIP) / (2 * (bw + bh))
      const x0 = (minX - dd - DET_PAD) / scale
      const y0 = (minY - dd - DET_PAD) / scale
      const x1 = (maxX + 1 + dd - DET_PAD) / scale
      const y1 = (maxY + 1 + dd - DET_PAD) / scale
      const rx = Math.max(0, x0)
      const ry = Math.max(0, y0)
      const rw = Math.min(W, x1) - rx
      const rh = Math.min(H, y1) - ry
      if (rw < 4 || rh < 4) continue
      boxes.push({ rect: { x: round1(rx), y: round1(ry), w: round1(rw), h: round1(rh) }, vertical: rh >= rw * 2 && rw >= 10 })
    }
    return sortReadingOrder(boxes)
  }

  // ---------------------------------------------------------------- 识别
  private async recognizeBoxes(img: RgbaImage, boxes: Box[]) {
    const items = boxes.map((b, i) => {
      const w = b.vertical ? b.rect.h : b.rect.w
      const h = b.vertical ? b.rect.w : b.rect.h
      return { i, ratio: w / h }
    })
    items.sort((a, b) => a.ratio - b.ratio)
    const results: { text: string; score: number; cx: number[] }[] = new Array(boxes.length)

    // 宽高比相近的分到一批，按批内最宽者补齐
    let k = 0
    const batches: { batch: typeof items; imgW: number }[] = []
    while (k < items.length) {
      const batch = [items[k]]
      let maxRatio = Math.max(REC_MIN_W / REC_H, items[k].ratio)
      while (k + batch.length < items.length && batch.length < 24) {
        const r = Math.max(maxRatio, items[k + batch.length].ratio)
        if ((batch.length + 1) * r > 260) break
        batch.push(items[k + batch.length])
        maxRatio = r
      }
      k += batch.length
      batches.push({ batch, imgW: Math.ceil((REC_H * maxRatio) / 8) * 8 })
    }

    for (const { batch, imgW } of batches) {
      const plane = REC_H * imgW
      const input = new Float32Array(batch.length * 3 * plane) // 0 即灰色补齐
      batch.forEach((it, bi) => this.fillRec(img, boxes[it.i], it.ratio, imgW, input, bi * 3 * plane))
      const res = await this.rec.run({ x: new ort.Tensor('float32', input, [batch.length, 3, REC_H, imgW]) })
      if (this.recArgmax) {
        const idx = res.best_idx
        const T = idx.dims[1] as number
        const ids = idx.data as BigInt64Array
        const ps = res.best_prob.data as Float32Array
        batch.forEach((it, bi) => (results[it.i] = this.withPositions(this.decodeIdx(ids, ps, bi * T, T), boxes[it.i], it.ratio, imgW, T)))
      } else {
        const out = res[this.rec.outputNames[0]]
        const [, T, C] = out.dims as number[]
        const probs = out.data as Float32Array
        batch.forEach((it, bi) => (results[it.i] = this.withPositions(this.decodeProbs(probs, bi * T * C, T, C), boxes[it.i], it.ratio, imgW, T)))
      }
    }
    return results
  }

  /** 把一个文字框裁出、缩放到高 48，写进批张量 */
  private fillRec(img: RgbaImage, box: Box, ratio: number, imgW: number, out: Float32Array, base: number) {
    const { data, width: W, height: H } = img
    const { rect, vertical } = box
    const tw = Math.min(imgW, Math.max(8, Math.ceil(REC_H * ratio)))
    const plane = REC_H * imgW
    if (!vertical) {
      const cols = axisTable(tw, rect.w, rect.x, W)
      const rows = axisTable(REC_H, rect.h, rect.y, H)
      for (let y = 0; y < REC_H; y++) {
        const r0 = rows.i0[y] * W
        const r1 = rows.i1[y] * W
        const ay = rows.a[y]
        let d = base + y * imgW
        for (let x = 0; x < tw; x++, d++) {
          const ax = cols.a[x]
          const p00 = (r0 + cols.i0[x]) * 4
          const p10 = (r0 + cols.i1[x]) * 4
          const p01 = (r1 + cols.i0[x]) * 4
          const p11 = (r1 + cols.i1[x]) * 4
          const tR = data[p00] + (data[p10] - data[p00]) * ax
          const bR = data[p01] + (data[p11] - data[p01]) * ax
          const tG = data[p00 + 1] + (data[p10 + 1] - data[p00 + 1]) * ax
          const bG = data[p01 + 1] + (data[p11 + 1] - data[p01 + 1]) * ax
          const tB = data[p00 + 2] + (data[p10 + 2] - data[p00 + 2]) * ax
          const bB = data[p01 + 2] + (data[p11 + 2] - data[p01 + 2]) * ax
          out[d] = REC_LUT[(tB + (bB - tB) * ay + 0.5) | 0]
          out[d + plane] = REC_LUT[(tG + (bG - tG) * ay + 0.5) | 0]
          out[d + 2 * plane] = REC_LUT[(tR + (bR - tR) * ay + 0.5) | 0]
        }
      }
      return
    }
    // 竖排：逆时针旋转 90°，输出的 x 对应原图从下到上
    for (let y = 0; y < REC_H; y++) {
      for (let x = 0; x < tw; x++) {
        const fx = clamp(rect.x + ((y + 0.5) / REC_H) * rect.w - 0.5, 0, W - 1)
        const fy = clamp(rect.y + rect.h - ((x + 0.5) / tw) * rect.h - 0.5, 0, H - 1)
        const p = ((fy | 0) * W + (fx | 0)) * 4
        const d = base + y * imgW + x
        out[d] = REC_LUT[data[p + 2]]
        out[d + plane] = REC_LUT[data[p + 1]]
        out[d + 2 * plane] = REC_LUT[data[p]]
      }
    }
  }

  private decodeIdx(ids: BigInt64Array, ps: Float32Array, off: number, T: number) {
    const chars: string[] = []
    const steps: number[] = []
    let last = 0
    let sum = 0
    for (let t = 0; t < T; t++) {
      const c = Number(ids[off + t])
      if (c !== 0 && c !== last && this.dict[c]) {
        chars.push(this.dict[c])
        steps.push(t)
        sum += ps[off + t]
      }
      last = c
    }
    return { chars, steps, score: chars.length ? sum / chars.length : 0 }
  }

  /** 时间步 → 原图中字符中心的横坐标（相对框左边） */
  private withPositions(d: { chars: string[]; steps: number[]; score: number }, box: Box, ratio: number, imgW: number, T: number) {
    const tw = Math.min(imgW, Math.max(8, Math.ceil(REC_H * ratio)))
    const step = imgW / T
    const k = (box.vertical ? box.rect.h : box.rect.w) / tw
    // 去掉首尾空白，位置数组与文本保持一一对应
    let a = 0
    let b = d.chars.length
    while (a < b && !d.chars[a].trim()) a++
    while (b > a && !d.chars[b - 1].trim()) b--
    return {
      text: d.chars.slice(a, b).join(''),
      score: d.score,
      cx: d.steps.slice(a, b).map((t) => Math.round((t + 0.5) * step * k * 10) / 10)
    }
  }

  private decodeProbs(p: Float32Array, off: number, T: number, C: number) {
    const chars: string[] = []
    const steps: number[] = []
    let last = 0
    let sum = 0
    for (let t = 0; t < T; t++) {
      const o = off + t * C
      let best = 0
      let bestP = p[o]
      for (let c = 1; c < C; c++) {
        if (p[o + c] > bestP) {
          bestP = p[o + c]
          best = c
        }
      }
      if (best !== 0 && best !== last && this.dict[best]) {
        chars.push(this.dict[best])
        steps.push(t)
        sum += bestP
      }
      last = best
    }
    return { chars, steps, score: chars.length ? sum / chars.length : 0 }
  }
}

// ---------------------------------------------------------------- 工具
/** 一维双线性采样表：目标 n 个采样点映射到源区间 [start, start+len) */
function axisTable(n: number, len: number, start: number, limit: number) {
  const i0 = new Int32Array(n)
  const i1 = new Int32Array(n)
  const a = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const f = clamp(start + ((k + 0.5) * len) / n - 0.5, 0, limit - 1)
    const lo = f | 0
    i0[k] = lo
    i1[k] = lo + 1 < limit ? lo + 1 : lo
    a[k] = f - lo
  }
  return { i0, i1, a }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}

function borderMean(img: RgbaImage): [number, number, number] {
  const { data, width: W, height: H } = img
  let r = 0, g = 0, b = 0, n = 0
  const add = (x: number, y: number) => {
    const i = (y * W + x) * 4
    r += data[i]
    g += data[i + 1]
    b += data[i + 2]
    n++
  }
  for (let x = 0; x < W; x += 2) {
    add(x, 0)
    add(x, H - 1)
  }
  for (let y = 0; y < H; y += 2) {
    add(0, y)
    add(W - 1, y)
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}

function round1(v: number) {
  return Math.round(v * 10) / 10
}

/** 阅读顺序：先按行（y 中心接近视为同一行），行内从左到右 */
function sortReadingOrder<T extends { rect: Rect }>(boxes: T[]): T[] {
  const sorted = [...boxes].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
  const rows: T[][] = []
  for (const b of sorted) {
    const cy = b.rect.y + b.rect.h / 2
    const row = rows.find((r) => {
      const ref = r[0].rect
      return Math.abs(ref.y + ref.h / 2 - cy) < Math.min(ref.h, b.rect.h) * 0.5
    })
    if (row) row.push(b)
    else rows.push([b])
  }
  rows.sort((a, b) => a[0].rect.y - b[0].rect.y)
  return rows.flatMap((r) => r.sort((a, b) => a.rect.x - b.rect.x))
}
