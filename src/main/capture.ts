// 屏幕截图（node-screenshots：Windows DXGI/GDI、macOS CoreGraphics）与窗口区域枚举
import { screen, type Display } from 'electron'
import { Monitor, Window } from 'node-screenshots'
import type { Rect } from '../shared/types'
import { windowOnCapture } from './capture-geometry'

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

/** 将截图显示器与 Electron 显示器对应：Windows 物理像素，macOS 点坐标 / CGDisplayID。 */
function matchMonitors(displays: Display[]): Map<number, MonitorInfo> {
  const monitors: MonitorInfo[] = Monitor.all().map((m) => ({ m, x: m.x(), y: m.y(), w: m.width(), h: m.height() }))
  const result = new Map<number, MonitorInfo>()
  const used = new Set<MonitorInfo>()
  for (const d of displays) {
    const mac = process.platform === 'darwin'
    const pw = Math.round(d.bounds.width * (mac ? 1 : d.scaleFactor))
    const ph = Math.round(d.bounds.height * (mac ? 1 : d.scaleFactor))
    // dipToScreenRect 只在 Windows 提供；Mac 上两边都使用 CoreGraphics 点坐标。
    const phys = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds
    let best: MonitorInfo | null = null
    let bestScore = Infinity
    for (const mi of monitors) {
      if (used.has(mi)) continue
      // macOS 的 Electron display.id 与 CGDirectDisplayID 相同，优先按 ID 匹配。
      if (mac && mi.m.id() === d.id) {
        best = mi
        break
      }
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

/** exclude：不参与窗口吸附的 Windows 句柄（按住空格穿透时，透明遮罩仍在最上面）。 */
export async function captureAll(exclude: Set<number> = new Set()): Promise<DisplayCapture[]> {
  const displays = screen.getAllDisplays()
  const map = matchMonitors(displays)
  // 窗口列表要在遮罩窗口显示之前取
  let wins: { x: number; y: number; w: number; h: number }[] = []
  try {
    wins = Window.all()
      .filter((w) => !w.isMinimized() && w.width() > 40 && w.height() > 24 && !exclude.has(w.id()))
      // Mac 的 nativeWindowHandle 是 NSView 指针，不能当作 CGWindowID。
      .filter((w) => process.platform !== 'darwin' || w.pid() !== process.pid)
      .sort((a, b) => b.z() - a.z())
      .map((w) => ({ x: w.x(), y: w.y(), w: w.width(), h: w.height() }))
  } catch {
    wins = []
  }

  const jobs = displays.map(async (display): Promise<DisplayCapture | null> => {
    const mi = map.get(display.id)
    if (!mi) return null
    const img = await mi.m.captureImage()
    const rgba = await img.toRaw(true)
    const windows: Rect[] = []
    for (const w of wins) {
      const rect = windowOnCapture(w, mi, img)
      if (rect) windows.push(rect)
    }
    return { display, width: img.width, height: img.height, scale: img.width / display.bounds.width, rgba, windows }
  })
  const captures = (await Promise.all(jobs)).filter((c): c is DisplayCapture => !!c)
  if (!captures.length) throw new Error('No displays available for screen capture')
  return captures
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
