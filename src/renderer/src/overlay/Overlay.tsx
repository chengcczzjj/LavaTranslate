import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  LANGUAGES,
  type BlockColors,
  type CaptureFrame,
  type ErrorCode,
  type OcrLine,
  type Phase,
  type Rect,
  type Settings,
  type TranslatedBlock
} from '@shared/types'
import { TranslationLayer } from '../components/TranslationLayer'
import { sampleColors } from '../lib/colors'
import { langBase, ReplyComposer } from './ReplyComposer'
import { Toolbar } from './Toolbar'

type Stage = 'hidden' | 'idle' | 'drawing' | 'selected'
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type Drag =
  | { kind: 'pending'; x0: number; y0: number }
  | { kind: 'draw'; x0: number; y0: number }
  | { kind: 'press'; x0: number; y0: number; rect: Rect; block: string | null }
  | { kind: 'move'; x0: number; y0: number; rect: Rect }
  | { kind: 'resize'; x0: number; y0: number; rect: Rect; edge: Edge }

interface FrameMeta {
  displayId: number
  width: number
  height: number
  scale: number
  windows: Rect[]
}

const MIN_SIZE = 6
/** 回复框宽度、预留高度（按展开后的高度预留位置，避免输出变长时跳位） */
const RP_W = 520
const RP_RESERVE = 220
const EDGES: Edge[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function Overlay() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const pixels = useRef<Uint8Array | null>(null)
  const [meta, setMeta] = useState<FrameMeta | null>(null)
  const [stage, setStage] = useState<Stage>('hidden')
  const [shown, setShown] = useState(false)
  const [sel, setSel] = useState<Rect | null>(null)
  const [snap, setSnap] = useState<Rect | null>(null)
  const [adjusting, setAdjusting] = useState(false)
  const drag = useRef<Drag | null>(null)
  const [vw, setVw] = useState(window.innerWidth)
  const [vh, setVh] = useState(window.innerHeight)

  // 翻译状态
  const reqId = useRef(0)
  const selPhys = useRef<Rect>({ x: 0, y: 0, w: 0, h: 0 })
  const [lines, setLines] = useState<OcrLine[]>([])
  const linesRef = useRef<OcrLine[]>([])
  const [blocks, setBlocks] = useState<TranslatedBlock[]>([])
  const [colors, setColors] = useState<Record<number, BlockColors>>({})
  const [phase, setPhase] = useState<Phase>('idle')
  const [lang, setLang] = useState<{ code: string; name: string; chat?: boolean } | null>(null)
  const [error, setError] = useState<{ message: string; code?: ErrorCode } | null>(null)
  const [stats, setStats] = useState<{ ms: number; firstTokenMs?: number; engine: string } | null>(null)
  const [target, setTarget] = useState('zh-Hans')
  const [mode, setMode] = useState<'overlay' | 'side'>('overlay')
  const [peek, setPeek] = useState(false)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [tipKey, setTipKey] = useState<string | null>(null)
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [hotkey, setHotkey] = useState('Alt+Q')
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [tbSize, setTbSize] = useState({ w: 520, h: 46 })

  // 回复助手
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyAssist, setReplyAssist] = useState(true)
  const [replyTone, setReplyTone] = useState<Settings['replyTone']>('auto')
  const replyDraft = useRef('')
  /** 用户手动收起过：这次框选里不再自动弹出 */
  const replyDismissed = useRef(false)
  const replyRef = useRef<HTMLDivElement>(null)
  const [rpH, setRpH] = useState(0)

  const scale = meta?.scale ?? window.devicePixelRatio

  // ------------------------------------------------------------ 帧
  const reset = useCallback(() => {
    reqId.current++
    drag.current = null
    setStage('hidden')
    setShown(false)
    setSel(null)
    setSnap(null)
    setAdjusting(false)
    setLines([])
    setBlocks([])
    setColors({})
    setPhase('idle')
    setLang(null)
    setError(null)
    setStats(null)
    setPeek(false)
    setHoverKey(null)
    setTipKey(null)
    setToast(null)
    setCapturing(false)
    setReplyOpen(false)
    replyDraft.current = ''
    replyDismissed.current = false
  }, [])

  useEffect(() => {
    const offFrame = window.lens.onFrame((f: CaptureFrame) => {
      reset()
      pixels.current = f.pixels
      const c = canvas.current!
      c.width = f.width
      c.height = f.height
      const ctx = c.getContext('2d', { alpha: false })!
      const view = new Uint8ClampedArray(f.pixels.buffer as ArrayBuffer, f.pixels.byteOffset, f.pixels.byteLength)
      ctx.putImageData(new ImageData(view, f.width, f.height), 0, 0)
      setMeta({ displayId: f.displayId, width: f.width, height: f.height, scale: f.scale, windows: f.windows })
      setTarget(f.targetLang)
      setMode(f.displayMode)
      setHotkey(f.hotkey)
      setReplyAssist(f.replyAssist)
      setReplyTone(f.replyTone)
      setVw(window.innerWidth)
      setVh(window.innerHeight)
      setStage('idle')
      if (f.cursor) {
        const s = f.scale
        const w = f.windows.find((r) => inside(f.cursor!.x * s, f.cursor!.y * s, r))
        if (w) setSnap(toCss(w, s))
      }
      // 隐藏窗口里 rAF 不会触发：画布已同步写入，直接通知主进程即可；
      // 真正显示前主进程会把窗口透明度设为 0，等可见后的首帧再显示
      setTimeout(() => window.lens.frameReady(), 0)
    })
    const offShown = window.lens.onShown(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          window.lens.visible()
          setShown(true)
        })
      )
    })
    const offReset = window.lens.onReset(() => {
      reset()
      pixels.current = null
      const c = canvas.current
      if (c) {
        c.width = 1
        c.height = 1
      }
    })
    return () => {
      offFrame()
      offShown()
      offReset()
    }
  }, [reset])

  // ------------------------------------------------------------ 翻译
  const startTranslate = useCallback(
    (rect: Rect, opts: { reuseOcr?: boolean; lang?: string } = {}) => {
      if (!meta) return
      const id = ++reqId.current
      const s = meta.scale
      const phys = {
        x: Math.round(rect.x * s),
        y: Math.round(rect.y * s),
        w: Math.round(rect.w * s),
        h: Math.round(rect.h * s)
      }
      selPhys.current = phys
      setPhase('ocr')
      setBlocks([])
      if (!opts.reuseOcr) setColors({})
      setError(null)
      setStats(null)
      setLang(null)
      setHoverKey(null)
      setTipKey(null)
      if (!opts.reuseOcr) {
        linesRef.current = []
        setLines([])
      }
      window.lens.translate({ requestId: id, displayId: meta.displayId, rect: phys, targetLang: opts.lang ?? target, reuseOcr: !!opts.reuseOcr })
    },
    [meta, target]
  )

  useEffect(() => {
    return window.lens.onTranslate(({ requestId, event }) => {
      if (requestId !== reqId.current) return
      switch (event.type) {
        case 'ocr': {
          linesRef.current = event.lines
          // OCR 一出来就按行采样颜色，译文到达时直接可用
          const px = pixels.current
          if (px && meta) {
            const o = selPhys.current
            const cs: Record<number, BlockColors> = {}
            for (const l of event.lines) cs[l.id] = sampleColors(px, meta.width, meta.height, { x: l.box.x + o.x, y: l.box.y + o.y, w: l.box.w, h: l.box.h }, l.box.h)
            setColors(cs)
          }
          setLines(event.lines)
          setPhase('translating')
          break
        }
        case 'lang':
          setLang({ code: event.code, name: event.name, chat: event.chat })
          break
        case 'block':
          setBlocks((bs) => [...bs, event.block])
          break
        case 'done':
          setPhase('done')
          setStats({ ms: event.ms, firstTokenMs: event.firstTokenMs, engine: event.engine })
          break
        case 'error':
          setPhase('error')
          setError({ message: event.message, code: event.code })
          break
      }
    })
  }, [meta])

  const covered = useMemo(() => new Set(blocks.flatMap((b) => b.lineIds)), [blocks])
  const pending = useMemo(
    () => (phase === 'translating' ? new Set(lines.filter((l) => !covered.has(l.id)).map((l) => l.id)) : null),
    [phase, lines, covered]
  )
  const progress = { done: lines.filter((l) => covered.has(l.id)).length, total: lines.length }

  // ------------------------------------------------------------ 指针交互
  const pointAt = (e: React.MouseEvent | MouseEvent) => ({ x: e.clientX, y: e.clientY })

  const finalize = useCallback(
    (r: Rect) => {
      const rect = clampRect(r, vw, vh)
      setSel(rect)
      setStage('selected')
      setAdjusting(false)
      startTranslate(rect)
    },
    [startTranslate, vw, vh]
  )

  const clearSelection = useCallback(() => {
    reqId.current++
    window.lens.cancel()
    setSel(null)
    setStage('idle')
    setLines([])
    setBlocks([])
    setColors({})
    setPhase('idle')
    setError(null)
    setLang(null)
    setStats(null)
    setReplyOpen(false)
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || stage === 'hidden') return
    const p = pointAt(e)
    const t = e.target as HTMLElement
    const edge = t.closest<HTMLElement>('[data-edge]')?.dataset.edge as Edge | undefined
    if (stage === 'selected' && sel) {
      if (edge) {
        drag.current = { kind: 'resize', x0: p.x, y0: p.y, rect: sel, edge }
        return
      }
      if (inside(p.x, p.y, sel)) {
        const block = t.closest<HTMLElement>('[data-block]')?.dataset.block ?? null
        drag.current = { kind: 'press', x0: p.x, y0: p.y, rect: sel, block }
        return
      }
    }
    drag.current = { kind: 'pending', x0: p.x, y0: p.y }
  }

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const p = pointAt(e)
      const d = drag.current
      if (!d) {
        if (stage === 'idle' && meta) {
          const w = meta.windows.find((r) => inside(p.x * meta.scale, p.y * meta.scale, r))
          const next = w ? toCss(w, meta.scale) : null
          setSnap((prev) => (sameRect(prev, next) ? prev : next))
        }
        return
      }
      const dist = Math.hypot(p.x - d.x0, p.y - d.y0)
      if (d.kind === 'pending' && dist > 3) {
        drag.current = { kind: 'draw', x0: d.x0, y0: d.y0 }
        reqId.current++
        window.lens.cancel()
        setStage('drawing')
        setReplyOpen(false)
        replyDismissed.current = false
        setSnap(null)
        setLines([])
        setBlocks([])
        setPhase('idle')
        setSel(norm(d.x0, d.y0, p.x, p.y))
      } else if (d.kind === 'draw') {
        setSel(clampRect(norm(d.x0, d.y0, p.x, p.y), vw, vh))
      } else if (d.kind === 'press' && dist > 3) {
        drag.current = { kind: 'move', x0: d.x0, y0: d.y0, rect: d.rect }
        reqId.current++
        window.lens.cancel()
        setAdjusting(true)
        setBlocks([])
        setLines([])
        setPhase('idle')
      } else if (d.kind === 'move') {
        const r = d.rect
        setSel({
          x: Math.max(0, Math.min(vw - r.w, r.x + p.x - d.x0)),
          y: Math.max(0, Math.min(vh - r.h, r.y + p.y - d.y0)),
          w: r.w,
          h: r.h
        })
      } else if (d.kind === 'resize') {
        if (!adjusting) {
          reqId.current++
          window.lens.cancel()
          setAdjusting(true)
          setBlocks([])
          setLines([])
          setPhase('idle')
        }
        setSel(clampRect(resize(d.rect, d.edge, p.x - d.x0, p.y - d.y0), vw, vh))
      }
    }
    const up = (e: MouseEvent) => {
      const d = drag.current
      drag.current = null
      if (!d || e.button !== 0) return
      // 用松开时的坐标直接算最终选区：最后一次 mousemove 的状态可能还没渲染
      const p = pointAt(e)
      if (d.kind === 'pending') {
        if (stage === 'idle' && snap) finalize(snap)
      } else if (d.kind === 'draw') {
        const r = clampRect(norm(d.x0, d.y0, p.x, p.y), vw, vh)
        if (r.w >= MIN_SIZE && r.h >= MIN_SIZE) finalize(r)
        else {
          setSel(null)
          setStage('idle')
        }
      } else if (d.kind === 'press') {
        if (d.block) copyBlock(d.block)
      } else if (d.kind === 'move') {
        const r = d.rect
        finalize({
          x: Math.max(0, Math.min(vw - r.w, r.x + p.x - d.x0)),
          y: Math.max(0, Math.min(vh - r.h, r.y + p.y - d.y0)),
          w: r.w,
          h: r.h
        })
      } else if (d.kind === 'resize') {
        finalize(clampRect(resize(d.rect, d.edge, p.x - d.x0, p.y - d.y0), vw, vh))
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  })

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (stage === 'selected' || stage === 'drawing') clearSelection()
    else window.lens.close()
  }

  // ------------------------------------------------------------ 操作
  const flash = (text: string) => setToast({ id: Date.now(), text })
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 1500)
    return () => clearTimeout(t)
  }, [toast])

  const allText = useCallback(
    (which: 'dst' | 'src') => blocks.map((b) => (which === 'dst' && !b.keep ? b.translation : b.source)).join('\n'),
    [blocks]
  )

  const copyBlock = (key: string) => {
    const b = blocks.find((x) => x.key === key)
    if (!b) return
    window.lens.copyText(b.keep ? b.source : b.translation)
    flash('已复制这段译文')
  }

  const copyAll = useCallback(() => {
    if (!blocks.length) return
    window.lens.copyText(allText('dst'))
    flash('已复制全部译文')
  }, [blocks, allText])

  const copyOriginal = useCallback(() => {
    if (!blocks.length) return
    window.lens.copyText(allText('src'))
    flash('已复制原文')
  }, [blocks, allText])

  const panel = useMemo(() => (sel && mode === 'side' ? sidePanel(sel, vw, vh, tbSize.h) : null), [sel, mode, vw, vh, tbSize.h])

  const captureRect = useCallback(() => {
    if (!sel) return null
    if (mode === 'side' && panel) return { x: panel.x, y: panel.y, w: sel.w * panel.s, h: sel.h * panel.s }
    return sel
  }, [sel, mode, panel])

  const withChromeHidden = useCallback(async (fn: () => Promise<unknown>) => {
    setCapturing(true)
    setHoverKey(null)
    setTipKey(null)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    try {
      return await fn()
    } finally {
      setCapturing(false)
    }
  }, [])

  const copyImage = useCallback(async () => {
    const r = captureRect()
    if (!r || !blocks.length) return
    await withChromeHidden(() => window.lens.copyImage(r))
    flash('已复制翻译截图')
  }, [captureRect, blocks, withChromeHidden])

  const saveImage = useCallback(async () => {
    const r = captureRect()
    if (!r || !blocks.length) return
    const ok = await withChromeHidden(() => window.lens.saveImage(r))
    window.lens.focusOverlay()
    if (ok) flash('已保存')
  }, [captureRect, blocks, withChromeHidden])

  const pin = useCallback(() => {
    if (!sel || !blocks.length || !canvas.current) return
    const o = selPhys.current
    const c = document.createElement('canvas')
    c.width = o.w
    c.height = o.h
    c.getContext('2d')!.drawImage(canvas.current, o.x, o.y, o.w, o.h, 0, 0, o.w, o.h)
    window.lens.pin({
      screenRect: { x: o.x / scale, y: o.y / scale, w: o.w / scale, h: o.h / scale },
      image: c.toDataURL('image/png'),
      scale,
      lines,
      blocks,
      colors,
      langName: lang?.name ?? '',
      targetLang: target,
      targetName: LANGUAGES.find((l) => l.code === target)?.name ?? target
    })
  }, [sel, blocks, lines, colors, lang, target, scale])

  const retry = useCallback(() => {
    if (sel) startTranslate(sel)
  }, [sel, startTranslate])

  const changeTarget = useCallback(
    (code: string) => {
      setTarget(code)
      void window.lens.setSettings({ targetLang: code })
      if (sel) startTranslate(sel, { reuseOcr: true, lang: code })
    },
    [sel, startTranslate]
  )

  const changeMode = useCallback((m: 'overlay' | 'side') => {
    setMode(m)
    setPeek(false)
    void window.lens.setSettings({ displayMode: m })
  }, [])

  // ------------------------------------------------------------ 回复助手
  const replyContext = useMemo(() => {
    const t = blocks.map((b) => b.source).join('\n')
    // 对话的最新消息一般在底部，太长时保留后半段
    return t.length > 3000 ? t.slice(-3000) : t
  }, [blocks])

  const focusReply = () => replyRef.current?.querySelector('textarea')?.focus()

  const toggleReply = useCallback(
    (fromKey = false) => {
      if (replyOpen && fromKey && !replyRef.current?.contains(document.activeElement)) return focusReply()
      replyDismissed.current = replyOpen
      setReplyOpen(!replyOpen)
    },
    [replyOpen]
  )

  const changeTone = useCallback((t: Settings['replyTone']) => {
    setReplyTone(t)
    void window.lens.setSettings({ replyTone: t })
  }, [])

  // 翻译完成后自动打开：开着「回复助手」、截图是外语、且模型判断是可以回复的对话
  useEffect(() => {
    if (phase !== 'done' || !replyAssist || replyDismissed.current) return
    if (!blocks.some((b) => !b.keep)) return
    if (lang && langBase(lang.code) === langBase(target)) return
    if (lang?.chat === false) return
    setReplyOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // ------------------------------------------------------------ 键盘
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (stage === 'hidden') return
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT') return
      const k = e.key.toLowerCase()
      // 回复框只会把「空白时的空格/Enter/Tab」和 Ctrl 组合键冒泡上来
      const inReply = el.tagName === 'TEXTAREA'
      if (inReply && e.ctrlKey && k === 'c') {
        const ta = el as HTMLTextAreaElement
        if (ta.selectionStart !== ta.selectionEnd) return
      }
      if (e.key === 'Escape') return window.lens.close()
      if (stage !== 'selected') return
      if (k === 'r' && !e.ctrlKey && !e.altKey && !e.metaKey && !inReply) {
        e.preventDefault()
        toggleReply(true)
      } else if (e.key === ' ') {
        e.preventDefault()
        if (!e.repeat && mode === 'overlay') setPeek(true)
      } else if (e.key === 'Tab') {
        e.preventDefault()
        changeMode(mode === 'overlay' ? 'side' : 'overlay')
      } else if (e.ctrlKey && e.shiftKey && k === 'c') {
        e.preventDefault()
        void copyImage()
      } else if (e.ctrlKey && k === 'c') {
        e.preventDefault()
        copyAll()
      } else if (e.ctrlKey && k === 's') {
        e.preventDefault()
        void saveImage()
      } else if (e.key === 'F3' || (e.ctrlKey && k === 't')) {
        e.preventDefault()
        pin()
      } else if ((e.ctrlKey && k === 'r') || e.key === 'F5') {
        e.preventDefault()
        retry()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (blocks.length) {
          window.lens.copyText(allText('dst'))
          window.lens.close()
        }
      } else if (e.altKey && k === 'c') {
        e.preventDefault()
        copyOriginal()
      }
    }
    const upK = (e: KeyboardEvent) => {
      if (e.key === ' ') setPeek(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', upK)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', upK)
    }
  }, [stage, mode, blocks, allText, copyAll, copyImage, copyOriginal, saveImage, pin, retry, changeMode, toggleReply])

  // ------------------------------------------------------------ 布局
  useLayoutEffect(() => {
    const el = toolbarRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTbSize({ w: el.offsetWidth, h: el.offsetHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  })

  const tbPos = useMemo(() => {
    if (!sel) return null
    const gap = 10
    let x = sel.x + sel.w - tbSize.w
    x = Math.max(8, Math.min(vw - tbSize.w - 8, x))
    let y = sel.y + sel.h + gap
    let up = false
    if (y + tbSize.h > vh - 8) {
      y = sel.y - tbSize.h - gap
      up = true
      if (y < 8) {
        y = sel.y + sel.h - tbSize.h - gap
        up = true
      }
    }
    // 语言面板向哪边展开：工具条在下方且下方空间不足时向上
    const pickerUp = up || y + tbSize.h + 330 > vh
    return { x, y, pickerUp }
  }, [sel, tbSize, vw, vh])

  useLayoutEffect(() => {
    const el = replyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setRpH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [replyOpen, stage, adjusting, capturing])

  const rpPos = useMemo(() => (sel && tbPos ? replyPlace(sel, tbPos, tbSize, Math.max(rpH, RP_RESERVE), vw, vh) : null), [sel, tbPos, tbSize, rpH, vw, vh])

  const working = phase === 'ocr' || phase === 'translating'
  const maskRect = stage === 'idle' ? snap : sel
  const showToolbar = stage === 'selected' && !adjusting && !capturing && tbPos
  const showReply = !!showToolbar && replyOpen && !!rpPos
  const s = scale

  // 悬停原文提示
  useEffect(() => {
    if (!hoverKey || mode !== 'overlay') {
      setTipKey(null)
      return
    }
    const t = setTimeout(() => setTipKey(hoverKey), 420)
    return () => clearTimeout(t)
  }, [hoverKey, mode])
  const tipBlock = tipKey ? blocks.find((b) => b.key === tipKey) : null
  const tipRect = tipBlock && sel ? blockCss(tipBlock, lines, s, sel) : null
  const hoverBlock = hoverKey && mode === 'side' ? blocks.find((b) => b.key === hoverKey) : null
  const hoverRect = hoverBlock && sel ? blockCss(hoverBlock, lines, s, sel) : null

  return (
    <div
      className={`overlay stage-${stage}${shown ? ' is-shown' : ''}`}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDoubleClick={(e) => {
        if (sel && inside(e.clientX, e.clientY, sel) && blocks.length) {
          window.lens.copyText(allText('dst'))
          window.lens.close()
        }
      }}
    >
      <canvas ref={canvas} className="bg" />

      {/* 遮罩：选区/窗口之外压暗 */}
      <motion.div
        className="mask"
        initial={false}
        animate={
          maskRect
            ? { left: maskRect.x, top: maskRect.y, width: maskRect.w, height: maskRect.h, opacity: shown ? 1 : 0 }
            : { left: vw / 2, top: vh / 2, width: 0, height: 0, opacity: shown ? 1 : 0 }
        }
        transition={
          stage === 'drawing' || drag.current?.kind === 'move' || drag.current?.kind === 'resize'
            ? { duration: 0 }
            : { type: 'spring', stiffness: 520, damping: 42, opacity: { duration: 0.22 } }
        }
      />

      {/* 窗口吸附高亮 */}
      <AnimatePresence>
        {stage === 'idle' && snap && shown && (
          <motion.div
            className="snap"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, left: snap.x, top: snap.y, width: snap.w, height: snap.h }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 520, damping: 42, opacity: { duration: 0.15 } }}
          />
        )}
      </AnimatePresence>

      {sel && stage === 'selected' && !adjusting && (
        <div className="sel-hit" style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }} />
      )}

      {/* 原位覆盖译文 */}
      {sel && mode === 'overlay' && stage === 'selected' && !adjusting && (
        <div className="layer-host" style={{ left: selPhys.current.x / s, top: selPhys.current.y / s }}>
          <TranslationLayer
            lines={lines}
            blocks={blocks}
            colors={colors}
            scale={s}
            width={selPhys.current.w / s}
            height={selPhys.current.h / s}
            targetLang={target}
            peek={peek}
            pending={pending}
            hoverKey={capturing ? null : hoverKey}
            onHover={setHoverKey}
          />
        </div>
      )}

      {/* 并排对照：在选区旁边复刻一份 */}
      <AnimatePresence>
        {sel && panel && stage === 'selected' && !adjusting && (
          <SidePanel
            key="side"
            panel={panel}
            sel={sel}
            phys={selPhys.current}
            source={canvas.current}
            capturing={capturing}
          >
            <TranslationLayer
              lines={lines}
              blocks={blocks}
              colors={colors}
              scale={s}
              width={selPhys.current.w / s}
              height={selPhys.current.h / s}
              targetLang={target}
              peek={false}
              pending={pending}
              hoverKey={capturing ? null : hoverKey}
              onHover={setHoverKey}
            />
          </SidePanel>
        )}
      </AnimatePresence>
      {hoverRect && !capturing && <div className="hover-outline" style={{ left: hoverRect.x - 3, top: hoverRect.y - 3, width: hoverRect.w + 6, height: hoverRect.h + 6 }} />}

      {/* 选区框 */}
      {sel && (stage === 'drawing' || stage === 'selected') && !capturing && (
        <div className={`sel-frame${working ? ' working' : ''}${phase === 'done' ? ' done' : ''}`} style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}>
          <div className="sel-glow" />
          {stage === 'selected' && EDGES.map((ed) => <div key={ed} className={`handle h-${ed}`} data-edge={ed} />)}
          {phase === 'ocr' && <div className="scanline" />}
        </div>
      )}

      {/* 尺寸 */}
      <AnimatePresence>
        {sel && (stage === 'drawing' || adjusting) && (
          <motion.div
            className="size-chip"
            style={{ left: sel.x, top: sel.y - 30 < 4 ? sel.y + 6 : sel.y - 30 }}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            {Math.round(sel.w * s)} × {Math.round(sel.h * s)}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 原文提示 */}
      <AnimatePresence>
        {tipBlock && tipRect && !peek && !capturing && (
          <motion.div
            key={tipBlock.key}
            className="orig-tip"
            style={tipPos(tipRect, vw, vh)}
            initial={{ opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="orig-label">原文 · 单击复制译文</div>
            <div className="orig-text">{tipBlock.source}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 工具条 */}
      <AnimatePresence>
        {showToolbar && (
          <Toolbar
            ref={toolbarRef}
            style={{ left: tbPos!.x, top: tbPos!.y }}
            phase={phase}
            error={error}
            lang={lang}
            target={target}
            progress={progress}
            stats={stats}
            mode={mode}
            peek={peek}
            pickerUp={tbPos!.pickerUp}
            onTarget={changeTarget}
            onMode={changeMode}
            onPeek={setPeek}
            onCopy={copyAll}
            onCopyImage={copyImage}
            onPin={pin}
            onSave={saveImage}
            onRetry={retry}
            onSettings={() => window.lens.openSettings()}
            onClose={() => window.lens.close()}
            reply={replyOpen}
            onReply={() => toggleReply()}
          />
        )}
      </AnimatePresence>

      {/* 回复助手 */}
      <AnimatePresence>
        {showReply && (
          <ReplyComposer
            key="reply"
            ref={replyRef}
            style={rpPos!.style}
            menuUp={rpPos!.menuUp}
            userLang={target}
            peer={lang}
            context={replyContext}
            tone={replyTone}
            draft={replyDraft}
            onTone={changeTone}
            onCollapse={() => {
              replyDismissed.current = true
              setReplyOpen(false)
            }}
            onExit={() => window.lens.close()}
            onCopied={(close) => {
              if (close) window.lens.close()
            }}
          />
        )}
      </AnimatePresence>

      {/* 顶部提示 */}
      <AnimatePresence>
        {stage === 'idle' && shown && (
          <motion.div
            className="hint"
            initial={{ opacity: 0, y: -10, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -8, x: '-50%', transition: { duration: 0.15 } }}
            transition={{ delay: 0.12, type: 'spring', stiffness: 420, damping: 32 }}
          >
            <span className="hint-mark" />
            <span>拖动框选要翻译的区域</span>
            <span className="hint-dot" />
            <span>单击选中窗口</span>
            <span className="hint-dot" />
            <span>
              <kbd>Esc</kbd> 退出
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 提示 toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            className="toast"
            style={toastPos(sel, tbPos, tbSize, vw, showReply)}
            initial={{ opacity: 0, y: 8, scale: 0.94, x: '-50%' }}
            animate={{ opacity: 1, y: 0, scale: 1, x: '-50%' }}
            exit={{ opacity: 0, y: -6, x: '-50%', transition: { duration: 0.15 } }}
            transition={{ type: 'spring', stiffness: 560, damping: 30 }}
          >
            <span className="toast-check" />
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>
      <span className="sr-only">{hotkey}</span>
    </div>
  )
}

// ------------------------------------------------------------ 并排面板
function SidePanel({
  panel,
  sel,
  phys,
  source,
  capturing,
  children
}: {
  panel: { x: number; y: number; s: number; from: 'right' | 'left' | 'below' | 'above' }
  sel: Rect
  phys: Rect
  source: HTMLCanvasElement | null
  capturing: boolean
  children: React.ReactNode
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const c = ref.current
    if (!c || !source) return
    c.width = phys.w
    c.height = phys.h
    c.getContext('2d')!.drawImage(source, phys.x, phys.y, phys.w, phys.h, 0, 0, phys.w, phys.h)
  }, [source, phys.x, phys.y, phys.w, phys.h])
  const off = { right: { x: -16, y: 0 }, left: { x: 16, y: 0 }, below: { x: 0, y: -16 }, above: { x: 0, y: 16 } }[panel.from]
  return (
    <motion.div
      className={`side-panel${capturing ? ' capturing' : ''}`}
      style={{ left: panel.x, top: panel.y, width: sel.w * panel.s, height: sel.h * panel.s }}
      initial={{ opacity: 0, x: off.x, y: off.y, scale: 0.97 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="side-inner" style={{ width: sel.w, height: sel.h, transform: `scale(${panel.s})` }}>
        <canvas ref={ref} className="side-bg" style={{ width: sel.w, height: sel.h }} />
        {children}
      </div>
    </motion.div>
  )
}

// ------------------------------------------------------------ 几何工具
function inside(x: number, y: number, r: Rect) {
  return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h
}

function norm(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
}

function clampRect(r: Rect, vw: number, vh: number): Rect {
  const x = Math.max(0, r.x)
  const y = Math.max(0, r.y)
  return { x, y, w: Math.min(vw - x, r.w - (x - r.x)), h: Math.min(vh - y, r.h - (y - r.y)) }
}

function toCss(r: Rect, s: number): Rect {
  return { x: r.x / s, y: r.y / s, w: r.w / s, h: r.h / s }
}

function sameRect(a: Rect | null, b: Rect | null) {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

function union(rs: Rect[]): Rect {
  const x0 = Math.min(...rs.map((r) => r.x))
  const y0 = Math.min(...rs.map((r) => r.y))
  const x1 = Math.max(...rs.map((r) => r.x + r.w))
  const y1 = Math.max(...rs.map((r) => r.y + r.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function resize(r: Rect, edge: Edge, dx: number, dy: number): Rect {
  let { x, y, w, h } = r
  if (edge.includes('w')) {
    x += dx
    w -= dx
  }
  if (edge.includes('e')) w += dx
  if (edge.includes('n')) {
    y += dy
    h -= dy
  }
  if (edge.includes('s')) h += dy
  if (w < 0) {
    x += w
    w = -w
  }
  if (h < 0) {
    y += h
    h = -h
  }
  return { x, y, w: Math.max(MIN_SIZE, w), h: Math.max(MIN_SIZE, h) }
}

function blockCss(b: TranslatedBlock, lines: OcrLine[], s: number, sel: Rect): Rect | null {
  const ls = lines.filter((l) => b.lineIds.includes(l.id))
  if (!ls.length) return null
  const u = union(ls.map((l) => l.box))
  return { x: sel.x + u.x / s, y: sel.y + u.y / s, w: u.w / s, h: u.h / s }
}

function tipPos(r: Rect, vw: number, vh: number): React.CSSProperties {
  const w = Math.min(420, Math.max(220, r.w))
  const left = Math.max(8, Math.min(vw - w - 8, r.x))
  if (r.y > 90) return { left, bottom: vh - r.y + 8, maxWidth: w }
  return { left, top: Math.min(vh - 60, r.y + r.h + 8), maxWidth: w }
}

function sidePanel(sel: Rect, vw: number, vh: number, tbH: number) {
  const gap = 14
  const m = 8
  const opts: { x: number; y: number; s: number; from: 'right' | 'left' | 'below' | 'above' }[] = []
  const fitS = (aw: number, ah: number) => Math.min(1, aw / sel.w, ah / sel.h)
  // 右
  {
    const s = fitS(vw - (sel.x + sel.w + gap) - m, vh - 2 * m)
    opts.push({ x: sel.x + sel.w + gap, y: Math.max(m, Math.min(vh - sel.h * s - m, sel.y)), s, from: 'right' })
  }
  // 左
  {
    const s = fitS(sel.x - gap - m, vh - 2 * m)
    opts.push({ x: sel.x - gap - sel.w * s, y: Math.max(m, Math.min(vh - sel.h * s - m, sel.y)), s, from: 'left' })
  }
  // 下（留出工具条）
  {
    const top = sel.y + sel.h + gap + tbH + gap
    const s = fitS(vw - 2 * m, vh - top - m)
    opts.push({ x: Math.max(m, Math.min(vw - sel.w * s - m, sel.x)), y: top, s, from: 'below' })
  }
  // 上
  {
    const s = fitS(vw - 2 * m, sel.y - gap - m)
    opts.push({ x: Math.max(m, Math.min(vw - sel.w * s - m, sel.x)), y: sel.y - gap - sel.h * s, s, from: 'above' })
  }
  const best = opts.filter((o) => o.s > 0).sort((a, b) => b.s - a.s)[0]
  return best && best.s >= 0.3 ? best : null
}

function toastPos(sel: Rect | null, tb: { x: number; y: number } | null, tbSize: { w: number; h: number }, vw: number, reply: boolean): React.CSSProperties {
  if (tb) {
    // 工具条在选区下方时 toast 放在工具条下面；回复框占了那个位置就换到另一侧
    const below = !!sel && tb.y > sel.y
    return { left: Math.min(vw - 120, tb.x + tbSize.w / 2), top: below !== reply ? tb.y + tbSize.h + 10 : tb.y - 44 }
  }
  return { left: vw / 2, top: 24 }
}

/**
 * 回复框的位置：优先贴着工具条（不挡选区），其次放在选区上/下方、左右两侧，都放不下才压在选区上。
 * 向上展开的位置用 bottom 定位，内容变长时向上长，不会跳位。
 */
function replyPlace(sel: Rect, tb: { x: number; y: number }, tbSize: { w: number; h: number }, H: number, vw: number, vh: number) {
  const g = 8
  const m = 8
  const W = Math.min(RP_W, vw - 2 * m)
  const x = Math.max(m, Math.min(vw - W - m, tb.x + tbSize.w - W))
  const tbAbove = tb.y + tbSize.h <= sel.y + 1
  const tbBelow = tb.y >= sel.y + sel.h - 1
  const down = (top: number, left = x) => ({ style: { left, top, width: W }, top })
  const up = (bottomY: number, left = x) => ({ style: { left, bottom: vh - bottomY, width: W }, top: bottomY - H })
  const fitsDown = (top: number) => top + H <= vh - m
  const fitsUp = (bottomY: number) => bottomY - H >= m

  let pick: { style: React.CSSProperties; top: number } | null = null
  const tbBottom = tb.y + tbSize.h + g
  if (tbBelow && fitsDown(tbBottom)) pick = down(tbBottom)
  else if (tbAbove && fitsUp(tb.y - g)) pick = up(tb.y - g)
  else if (fitsUp(sel.y - g) && !tbAbove) pick = up(sel.y - g)
  else if (fitsDown(sel.y + sel.h + g) && !tbBelow) pick = down(sel.y + sel.h + g)
  else {
    // 选区很高（比如整个聊天窗口）：放在左右两侧，和选区底部（输入框附近）对齐
    const bottomY = Math.min(vh - m, Math.max(H + m, sel.y + sel.h))
    if (vw - (sel.x + sel.w) - g - m >= W) pick = up(bottomY, sel.x + sel.w + g)
    else if (sel.x - g - m >= W) pick = up(bottomY, sel.x - g - W)
    else pick = tb.y > vh / 2 ? up(Math.max(H + m, tb.y - g)) : down(Math.min(vh - m - H, tbBottom))
  }
  // 语言菜单（约 300px）默认从标题栏向下展开，放不下时向上
  const menuUp = pick.top + 340 > vh - m && pick.top - 300 > m
  return { style: pick.style, menuUp }
}
