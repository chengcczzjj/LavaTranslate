import { AnimatePresence, motion } from 'motion/react'
import { Copy, Eye, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PinPayload } from '@shared/types'
import { TranslationLayer } from '../components/TranslationLayer'

const MARGIN = 18

export function Pin() {
  const [data, setData] = useState<PinPayload | null>(null)
  const [zoom, setZoom] = useState(1)
  const [peek, setPeek] = useState(false)
  const [hover, setHover] = useState(false)
  const [closing, setClosing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const moved = useRef(false)

  useEffect(() => window.lens.onPinData(setData), [])

  const close = useCallback(() => {
    setClosing(true)
    setTimeout(() => window.lens.pinClose(), 160)
  }, [])

  const copy = useCallback(() => {
    if (!data) return
    window.lens.copyText(data.blocks.map((b) => (b.keep ? b.source : b.translation)).join('\n'))
    setToast('已复制译文')
  }, [data])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 1300)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      else if (e.key === ' ') setPeek(e.type === 'keydown')
      else if (e.ctrlKey && e.key.toLowerCase() === 'c' && e.type === 'keydown') copy()
    }
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', key)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', key)
    }
  }, [close, copy])

  useEffect(() => {
    const up = () => window.lens.pinDrag(false)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  if (!data) return null
  const w = data.screenRect.w
  const h = data.screenRect.h

  return (
    <div
      className="pin-root"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false)
        setPeek(false)
      }}
    >
      <motion.div
        className="pin-card"
        style={{ left: MARGIN, top: MARGIN, width: w * zoom, height: h * zoom }}
        initial={{ boxShadow: '0 0 0 1px rgba(255,90,31,0.9), 0 0 0 0 rgba(255,90,31,0.5), 0 2px 6px rgba(0,0,0,0)' }}
        animate={{
          opacity: closing ? 0 : 1,
          scale: closing ? 0.96 : 1,
          boxShadow: hover
            ? '0 0 0 1px rgba(255,90,31,0.85), 0 0 0 4px rgba(255,90,31,0.18), 0 10px 26px rgba(0,0,0,0.38)'
            : '0 0 0 1px rgba(255,255,255,0.22), 0 0 0 0 rgba(255,90,31,0), 0 8px 22px rgba(0,0,0,0.32)'
        }}
        transition={{ duration: closing ? 0.15 : 0.35, ease: [0.22, 1, 0.36, 1] }}
        onMouseDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('.pin-tools')) return
          moved.current = false
          window.lens.pinDrag(true)
        }}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest('.pin-tools')) close()
        }}
        onWheel={(e) => {
          const next = Math.max(0.3, Math.min(4, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
          setZoom(next)
          window.lens.pinZoom(next)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          close()
        }}
      >
        <div className="pin-inner" style={{ width: w, height: h, transform: `scale(${zoom})` }}>
          <img
            src={data.image}
            width={w}
            height={h}
            draggable={false}
            onLoad={(e) => {
              // 窗口尚未显示，rAF 不会触发；等图片解码完再通知主进程显示
              void e.currentTarget.decode().finally(() => setTimeout(() => window.lens.pinReady(), 16))
            }}
          />
          <TranslationLayer
            lines={data.lines}
            blocks={data.blocks}
            colors={data.colors}
            scale={data.scale}
            width={w}
            height={h}
            targetLang={data.targetLang}
            peek={peek}
            pending={null}
            hoverKey={hoverKey}
            onHover={setHoverKey}
          />
        </div>

        <AnimatePresence>
          {hover && !closing && (
            <motion.div
              className="pin-tools"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
            >
              <button
                className={peek ? 'on' : ''}
                title="按住查看原文（Space）"
                onMouseDown={() => setPeek(true)}
                onMouseUp={() => setPeek(false)}
                onMouseLeave={() => setPeek(false)}
              >
                <Eye size={14} />
              </button>
              <button title="复制译文（Ctrl+C）" onClick={copy}>
                <Copy size={13} />
              </button>
              <button title="关闭（Esc / 双击）" onClick={close}>
                <X size={14} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {zoom !== 1 && hover && (
            <motion.div className="pin-zoom" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {Math.round(zoom * 100)}%
            </motion.div>
          )}
          {toast && (
            <motion.div className="pin-toast" initial={{ opacity: 0, y: 6, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, x: '-50%' }}>
              {toast}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
