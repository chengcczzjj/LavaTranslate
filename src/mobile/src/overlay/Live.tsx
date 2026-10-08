import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LANGUAGES, type BlockColors, type OcrLine, type Rect, type TranslatedBlock } from '@shared/types'
import { TranslationLayer } from '@renderer/components/TranslationLayer'
import { sampleColors } from '@renderer/lib/colors'
import { ReplyComposer } from '@renderer/overlay/ReplyComposer'
import { call, notify, on } from '../bridge'
import { engineFor, engineProblem, type MobileSettings } from '../engine'
import { LiveCache } from './liveCache'

// 实时翻译（无障碍模式）：窗口本身不接触摸，这里只画译文块，盖在原文的位置上，其余透明、露出真实的应用。
// 原生每次读屏（滑动停下后）推来一帧：文字（来自界面节点或 OCR）+ 截图。先套用缓存里翻过的块，
// 剩下的行再交给模型，流式补上。显示与隐藏（滑动时、按住对比时）由原生改窗口透明度，不经过这里。

interface LiveFrame {
  frame: { id: number; w: number; h: number; content: Rect }
  lines: OcrLine[]
  image: { base64: string; mediaType: 'image/png' | 'image/jpeg'; width: number; height: number; factor: number }
  source: 'nodes' | 'ocr'
}

interface Props {
  density: number
  settings: () => MobileSettings | null
  insets: { top: number; bottom: number; ime: number }
}

/** 译文缓存跨多次实时翻译保留（网页释放时才清空） */
const sharedCache = new LiveCache()

export function Live({ density, settings, insets }: Props) {
  const cache = useRef(sharedCache)
  const gen = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const [frame, setFrame] = useState<LiveFrame['frame'] | null>(null)
  const [lines, setLines] = useState<OcrLine[]>([])
  const [blocks, setBlocks] = useState<TranslatedBlock[]>([])
  const [colors, setColors] = useState<Record<number, BlockColors>>({})
  const [translating, setTranslating] = useState(false)
  const [lang, setLang] = useState<{ code: string; name: string; chat?: boolean } | null>(null)
  const [replyOpen, setReplyOpen] = useState(false)
  const [tone, setTone] = useState<MobileSettings['replyTone']>(settings()?.replyTone ?? 'auto')
  const replyDraft = useRef('')
  // 对话上下文：最近几屏的原文（回复时用）
  const history = useRef<string[]>([])

  /** 这一帧有东西可显示了：等画上屏幕再让原生把译文层亮出来 */
  const shown = useRef(0)
  const reveal = useCallback((id: number) => {
    if (shown.current === id) return
    shown.current = id
    requestAnimationFrame(() => requestAnimationFrame(() => notify('live.visible', { frame: id })))
  }, [])

  const stop = useCallback(() => {
    gen.current++
    abort.current?.abort()
    abort.current = null
  }, [])

  const onFrame = useCallback(
    async (d: LiveFrame) => {
      stop()
      const id = ++gen.current
      const st = settings()
      const f = d.frame
      // 截图像素只用来取文字和背景的颜色
      let px: Uint8Array | null = null
      try {
        px = new Uint8Array(await (await fetch(`/frame/${f.id}`)).arrayBuffer())
      } catch {
        /* 取不到就用默认配色 */
      }
      if (id !== gen.current) return
      const cs: Record<number, BlockColors> = {}
      if (px) for (const l of d.lines) cs[l.id] = sampleColors(px, f.w, f.h, { x: l.box.x + f.content.x, y: l.box.y + f.content.y, w: l.box.w, h: l.box.h }, l.box.h)
      if (st) cache.current.useTarget(st.targetLang)
      const { blocks: hit, rest } = cache.current.match(d.lines, f.id)
      setFrame(f)
      setColors(cs)
      setLines(d.lines)
      setBlocks(hit)
      const text = d.lines.map((l) => l.text).join('\n')
      if (text) history.current = [...history.current.filter((t) => t !== text), text].slice(-4)
      if (hit.length) reveal(f.id)
      console.info('[lava] live', JSONStr({ source: d.source, lines: d.lines.length, cached: d.lines.length - rest.length }))
      if (!rest.length) {
        setTranslating(false)
        notify('live.state', { phase: 'done' })
        return
      }
      const eng = st && engineFor(st)
      if (!st || !eng) {
        notify('live.state', { phase: 'error', message: (st && engineProblem(st)) ?? '翻译服务还没有配置' })
        return
      }
      setTranslating(true)
      notify('live.state', { phase: 'translating' })
      const ctl = (abort.current = new AbortController())
      const tgt = LANGUAGES.find((l) => l.code === st.targetLang) ?? LANGUAGES[0]
      const { factor, ...image } = d.image
      const scaled = factor === 1 ? rest : rest.map((l) => ({ ...l, box: { x: l.box.x * factor, y: l.box.y * factor, w: l.box.w * factor, h: l.box.h * factor } }))
      const t0 = performance.now()
      try {
        await eng.translate(
          { image, lines: scaled, target: tgt, styleHint: st.styleHint },
          (ev) => {
            if (id !== gen.current) return
            if (ev.type === 'lang') setLang({ code: ev.code, name: ev.name, chat: ev.chat })
            else if (ev.type === 'block') {
              const b = { ...ev.block, key: `f${f.id}-${ev.block.key}` }
              cache.current.add(d.lines, b)
              setBlocks((bs) => [...bs, b])
              reveal(f.id)
            }
          },
          ctl.signal
        )
        if (id !== gen.current) return
        console.info('[lava] live done', JSONStr({ ms: Math.round(performance.now() - t0), lines: rest.length }))
        notify('live.state', { phase: 'done' })
      } catch (e) {
        if (id !== gen.current || ctl.signal.aborted) return
        notify('live.state', { phase: 'error', message: (e as Error).message })
      } finally {
        if (id === gen.current) setTranslating(false)
      }
    },
    [settings, stop, reveal]
  )

  useEffect(() => {
    const offs = [
      on<LiveFrame>('live.frame', (d) => void onFrame(d)),
      // 滑动了：停下正在进行的翻译（窗口已由原生藏起）
      on('live.hide', () => {
        stop()
        setTranslating(false)
      }),
      on('live.reply', () => setReplyOpen(true)),
      on('back', () => closeRef.current()),
      on('live.stop', () => {
        stop()
        setReplyOpen(false)
        setBlocks([])
        setLines([])
        setFrame(null)
      })
    ]
    return () => {
      offs.forEach((f) => f())
      stop()
    }
  }, [onFrame, stop])

  const closeReply = useCallback(() => {
    ;(window as unknown as { lens?: { replyCancel(): void } }).lens?.replyCancel()
    setReplyOpen(false)
    notify('live.replyClosed')
  }, [])
  const closeRef = useRef(closeReply)
  closeRef.current = closeReply

  const covered = useMemo(() => new Set(blocks.flatMap((b) => b.lineIds)), [blocks])
  const pending = useMemo(() => (translating ? new Set(lines.filter((l) => !covered.has(l.id)).map((l) => l.id)) : null), [translating, lines, covered])
  const target = settings()?.targetLang ?? 'zh-Hans'
  const keyboard = insets.ime > 0

  return (
    <>
      {frame && (
        <div className="m-layer" style={{ left: frame.content.x / density, top: frame.content.y / density }}>
          <TranslationLayer
            lines={lines}
            blocks={blocks}
            colors={colors}
            scale={density}
            width={frame.content.w / density}
            height={frame.content.h / density}
            targetLang={target}
            peek={false}
            pending={pending}
          />
        </div>
      )}
      <AnimatePresence>
        {replyOpen && (
          <>
            <motion.div className="m-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={closeReply} />
            <ReplyComposer
              key="live-reply"
              quick={false}
              style={{ left: 10, right: 10, bottom: (keyboard ? insets.ime : insets.bottom) + 10 }}
              menuUp
              userLang={target}
              peer={lang}
              context={history.current.join('\n').slice(-3000)}
              tone={tone}
              draft={replyDraft}
              onTone={(t) => {
                setTone(t)
                void call('settings', { replyTone: t }).catch(() => {})
              }}
              onCollapse={closeReply}
              onExit={closeReply}
              onCopied={(andClose) => {
                notify('haptic', { kind: 'confirm' })
                if (andClose) closeReply()
              }}
            />
          </>
        )}
      </AnimatePresence>
    </>
  )
}

const JSONStr = (o: object) => JSON.stringify(o)
