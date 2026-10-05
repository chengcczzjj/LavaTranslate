import { animate, AnimatePresence, motion, useMotionValue } from 'motion/react'
import { useEffect, useMemo, useRef } from 'react'
import type { Phase } from '@shared/types'

// 翻译界面里的悬浮球：与原生悬浮球外观、位置完全一致（原生的那个此时藏起来）。
// 单击退出翻译（菜单开着时是收起菜单），长按打开菜单，拖动换位置（松手吸附到最近的一侧）

export interface OrbItem {
  id: string
  label: string
  icon: React.ReactNode
  active?: boolean
  disabled?: boolean
}

interface Props {
  x: number
  y: number
  size: number
  vw: number
  vh: number
  safeTop: number
  safeBottom: number
  phase: Phase
  progress: { done: number; total: number }
  menu: boolean
  items: OrbItem[]
  /** 单击 */
  onTap: () => void
  /** 长按 */
  onMenu: () => void
  onPick: (id: string) => void
  onMoved: (side: 'left' | 'right', y: number) => void
  haptic: (kind: 'tick' | 'long' | 'confirm') => void
}

const MARGIN = 6
/** 菜单弧线半径、相邻两项的间距、胶囊高度 */
const ARC = 132
const STEP = 54
const PILL = 44

export function Orb(p: Props) {
  const mx = useMotionValue(p.x)
  const my = useMotionValue(p.y)
  const drag = useRef<{ x0: number; y0: number; ox: number; oy: number; moved: boolean; long: boolean; timer: number } | null>(null)

  useEffect(() => {
    mx.set(p.x)
    my.set(p.y)
  }, [p.x, p.y, mx, my])

  const down = (e: React.PointerEvent) => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const d = { x0: e.clientX, y0: e.clientY, ox: mx.get(), oy: my.get(), moved: false, long: false, timer: 0 }
    d.timer = window.setTimeout(() => {
      d.long = true
      p.haptic('long')
      p.onMenu()
    }, 380)
    drag.current = d
  }

  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.long) return
    const dx = e.clientX - d.x0
    const dy = e.clientY - d.y0
    if (!d.moved && Math.hypot(dx, dy) > 8) {
      d.moved = true
      clearTimeout(d.timer)
    }
    if (d.moved) {
      mx.set(d.ox + dx)
      my.set(clamp(d.oy + dy, p.safeTop + MARGIN, p.vh - p.safeBottom - p.size - MARGIN))
    }
  }

  const up = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    clearTimeout(d.timer)
    if (d.long) return
    if (!d.moved) {
      p.haptic('tick')
      return p.onTap()
    }
    const side = mx.get() + p.size / 2 < p.vw / 2 ? 'left' : 'right'
    const tx = side === 'left' ? MARGIN : p.vw - MARGIN - p.size
    animate(mx, tx, { type: 'spring', stiffness: 520, damping: 34 })
    p.onMoved(side, my.get())
  }

  // 菜单：一列胶囊沿弧线排在球的内侧，图标在弧上、文字朝屏幕内；靠近顶部 / 底部时整列平移，不出屏幕
  const side = p.x + p.size / 2 < p.vw / 2 ? 'left' : 'right'
  const spots = useMemo(() => {
    const n = p.items.length
    const cx = p.x + p.size / 2
    const cy = p.y + p.size / 2
    const lo = p.safeTop + 10 + PILL / 2
    const hi = p.vh - p.safeBottom - 10 - PILL / 2
    const span = (n - 1) * STEP
    const first = Math.max(lo, Math.min(hi - span, cy - span / 2))
    return p.items.map((_, i) => {
      const y = first + i * STEP
      const dy = Math.max(-0.96, Math.min(0.96, (y - cy) / ARC))
      const dx = ARC * Math.cos(Math.asin(dy))
      return { x: side === 'right' ? cx - dx : cx + dx, y }
    })
  }, [p.items, p.x, p.y, p.size, p.vh, p.safeTop, p.safeBottom, side])

  const ring = p.size / 2 + 5
  const C = 2 * Math.PI * ring
  const working = p.phase === 'ocr' || p.phase === 'translating'
  const frac = p.phase === 'translating' && p.progress.total ? p.progress.done / p.progress.total : 0

  return (
    <>
      <AnimatePresence>
        {p.menu &&
          p.items.map((it, i) => {
            const at = spots[i]
            const from = { x: p.x + p.size / 2 - at.x, y: p.y + p.size / 2 - at.y }
            return (
              <motion.button
                key={it.id}
                className={`m-fan ${side}${it.active ? ' on' : ''}`}
                disabled={it.disabled}
                style={side === 'right' ? { right: p.vw - at.x - PILL / 2, top: at.y - PILL / 2, height: PILL } : { left: at.x - PILL / 2, top: at.y - PILL / 2, height: PILL }}
                initial={{ ...from, scale: 0.3, opacity: 0 }}
                animate={{ x: 0, y: 0, scale: 1, opacity: 1 }}
                exit={{ ...from, scale: 0.3, opacity: 0, transition: { duration: 0.16, delay: (p.items.length - i) * 0.012 } }}
                transition={{ type: 'spring', stiffness: 560, damping: 32, delay: i * 0.022 }}
                onClick={() => p.onPick(it.id)}
              >
                <span className="m-fan-icon">{it.icon}</span>
                <span className="m-fan-label">{it.label}</span>
              </motion.button>
            )
          })}
      </AnimatePresence>

      <motion.div
        className={`m-orb${p.menu ? ' open' : ''}`}
        style={{ x: mx, y: my, width: p.size, height: p.size }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        whileTap={{ scale: 0.92 }}
        transition={{ type: 'spring', stiffness: 600, damping: 30 }}
      >
        <svg className="m-orb-ring" width={ring * 2 + 6} height={ring * 2 + 6} viewBox={`${-ring - 3} ${-ring - 3} ${ring * 2 + 6} ${ring * 2 + 6}`}>
          <defs>
            <linearGradient id="orb-ring" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#FF3B30" />
              <stop offset="0.5" stopColor="#FF7A1A" />
              <stop offset="1" stopColor="#FFC24A" />
            </linearGradient>
          </defs>
          <AnimatePresence>
            {working && (
              <motion.circle
                key="ring"
                r={ring}
                fill="none"
                stroke="url(#orb-ring)"
                strokeWidth={2.6}
                strokeLinecap="round"
                strokeDasharray={C}
                className={p.phase === 'ocr' ? 'spin' : undefined}
                initial={{ opacity: 0, strokeDashoffset: C }}
                animate={{ opacity: 1, strokeDashoffset: p.phase === 'ocr' ? C * 0.72 : C * (1 - Math.max(0.04, frac)) }}
                exit={{ strokeDashoffset: 0, opacity: 0, transition: { strokeDashoffset: { duration: 0.35 }, opacity: { duration: 0.4, delay: 0.45 } } }}
                transition={{ type: 'spring', stiffness: 120, damping: 24 }}
                transform="rotate(-90)"
              />
            )}
          </AnimatePresence>
        </svg>
        <div className="m-orb-ball">
          <OrbGlyph />
        </div>
      </motion.div>
    </>
  )
}

/** 一滴发光的熔岩，里面两行文字（与应用图标同一画法：scripts/icons/lava.py，1024 视口） */
export function OrbGlyph() {
  return (
    <svg className="m-orb-glyph" viewBox="236 106 552 786">
      <defs>
        <linearGradient id="og-lava" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FF2D2D" />
          <stop offset="0.55" stopColor="#FF5A1F" />
          <stop offset="1" stopColor="#FFB627" />
        </linearGradient>
        <radialGradient id="og-hl" cx="0.36" cy="0.42" r="0.32">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="og-sd" cx="0.7" cy="0.85" r="0.6">
          <stop offset="0.4" stopColor="#7A1400" stopOpacity="0" />
          <stop offset="1" stopColor="#7A1400" stopOpacity="0.35" />
        </radialGradient>
      </defs>
      <path d={DROP} fill="url(#og-lava)" />
      <path d={DROP} fill="url(#og-sd)" />
      <path d={DROP} fill="url(#og-hl)" />
      <rect x="392" y="600" width="240" height="50" rx="25" fill="#fff" fillOpacity="0.95" />
      <rect x="392" y="684" width="160" height="50" rx="25" fill="#fff" fillOpacity="0.95" />
    </svg>
  )
}

const DROP = 'M512,146 L307.91,497.5 A236,236 0 1 0 716.09,497.5 Z'

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}
