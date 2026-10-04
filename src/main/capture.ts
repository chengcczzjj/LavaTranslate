// 屏幕截图（node-screenshots，DXGI/GDI，单屏 ~30ms）与窗口区域枚举
import { screen, type Display } from 'electron'
import { Monitor, Window } from 'node-screenshots'
import type { Rect } from '../shared/types'

export interface DisplayCapture {
  display: Display
  width: number
  height: number
  scale: number
  rgba: Buffer
  /** 该显示器上可见窗口的区域（物理像素，相对显示器左上角，按 z 序从上到下） */
  windows: Rect[]
}

interface MonitorInfo {
  m: Monitor
  x: number
  y: number
  w: number
  h: number
}

/** 把 node-screenshots 的物理坐标显示器与 Electron 的 DIP 显示器一一对应 */
function matchMonitors(displays: Display[]): Map<number, MonitorInfo> {
  const monitors: MonitorInfo[] = Monitor.all().map((m) => ({ m, x: m.x(), y: m.y(), w: m.width(), h: m.height() }))
  const result = new Map<number, MonitorInfo>()
  const used = new Set<MonitorInfo>()
  for (const d of displays) {
    const pw = Math.round(d.bounds.width * d.scaleFactor)
    const ph = Math.round(d.bounds.height * d.scaleFactor)
    const phys = screen.dipToScreenRect(null, d.bounds)
    let best: MonitorInfo | null = null
    let bestScore = Infinity
    for (const mi of monitors) {
      if (used.has(mi)) continue
      const sizeDiff = Math.abs(mi.w - pw) + Math.abs(mi.h - ph)
      const posDiff = Math.abs(mi.x - phys.x) + Math.abs(mi.y - phys.y)
      const score = sizeDiff * 10 + posDiff
      if (score < bestScore) {
        bestScore = score
        best = mi
      }
    }
    if (best) {
      used.add(best)
      result.set(d.id, best)
    }
  }
  return result
}

export async function captureAll(): Promise<DisplayCapture[]> {
  const displays = screen.getAllDisplays()
  const map = matchMonitors(displays)
  // 窗口列表要在遮罩窗口显示之前取
  let wins: { x: number; y: number; w: number; h: number }[] = []
  try {
    wins = Window.all()
      .filter((w) => !w.isMinimized() && w.width() > 40 && w.height() > 24)
      .sort((a, b) => b.z() - a.z())
      .map((w) => ({ x: w.x(), y: w.y(), w: w.width(), h: w.height() }))
  } catch {
    wins = []
  }

  const jobs = displays.map(async (display): Promise<DisplayCapture | null> => {
    const mi = map.get(display.id)
    if (!mi) return null
    const img = await mi.m.captureImage()
    const rgba = await img.toRaw()
    const windows: Rect[] = []
    for (const w of wins) {
      const x0 = Math.max(w.x, mi.x) - mi.x
      const y0 = Math.max(w.y, mi.y) - mi.y
      const x1 = Math.min(w.x + w.w, mi.x + mi.w) - mi.x
      const y1 = Math.min(w.y + w.h, mi.y + mi.h) - mi.y
      if (x1 - x0 > 40 && y1 - y0 > 24) windows.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    }
    return { display, width: img.width, height: img.height, scale: img.width / display.bounds.width, rgba, windows }
  })
  return (await Promise.all(jobs)).filter((c): c is DisplayCapture => !!c)
}

/** 从 RGBA 整屏截图中裁出一块 */
export function cropRgba(src: Buffer | Uint8Array, srcW: number, r: Rect): Uint8Array {
  const x = Math.round(r.x)
  const y = Math.round(r.y)
  const w = Math.round(r.w)
  const h = Math.round(r.h)
  const out = new Uint8Array(w * h * 4)
  for (let row = 0; row < h; row++) {
    const s = ((y + row) * srcW + x) * 4
    out.set(src.subarray(s, s + w * 4), row * w * 4)
  }
  return out
}

/** RGBA → BGRA（Electron nativeImage 需要 BGRA） */
export function rgbaToBgra(src: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(src.length)
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i + 2]
    out[i + 1] = src[i + 1]
    out[i + 2] = src[i]
    out[i + 3] = 255
  }
  return out
}
