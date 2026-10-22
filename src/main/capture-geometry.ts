import type { Rect } from '../shared/types'

/** macOS 的 CGWindow/CGDisplay 坐标是点，截图是像素；Windows 两者都是物理像素。 */
export function windowOnCapture(window: Rect, monitor: Rect, image: { width: number; height: number }): Rect | null {
  if (monitor.w <= 0 || monitor.h <= 0) return null
  const left = Math.max(window.x, monitor.x)
  const top = Math.max(window.y, monitor.y)
  const right = Math.min(window.x + window.w, monitor.x + monitor.w)
  const bottom = Math.min(window.y + window.h, monitor.y + monitor.h)
  if (right <= left || bottom <= top) return null
  const sx = image.width / monitor.w
  const sy = image.height / monitor.h
  const x = Math.round((left - monitor.x) * sx)
  const y = Math.round((top - monitor.y) * sy)
  const w = Math.round((right - monitor.x) * sx) - x
  const h = Math.round((bottom - monitor.y) * sy) - y
  return w > 40 && h > 24 ? { x, y, w, h } : null
}
