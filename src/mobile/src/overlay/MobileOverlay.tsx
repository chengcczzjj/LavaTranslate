import { AnimatePresence, motion } from 'motion/react'
import { Check, Copy, Eye, EyeOff, Languages, MessageSquareReply, RotateCcw, Settings2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LANGUAGES, type BlockColors, type ErrorCode, type OcrLine, type Phase, type Rect, type TranslatedBlock } from '@shared/types'
import { TranslationLayer } from '@renderer/components/TranslationLayer'
import { sampleColors } from '@renderer/lib/colors'
import { ReplyComposer } from '@renderer/overlay/ReplyComposer'
import { call, notify, on } from '../bridge'
import { engineFor, engineProblem, type MobileSettings } from '../engine'
import { Orb, type OrbItem } from './Orb'
import { installReplyHost } from './replyHost'

// 手机版全屏翻译：原生截一帧 → 这里画出截图（与屏幕一模一样）→ 取 OCR 结果 → 调模型流式翻译，译文按原排版就地浮现。
// 悬浮球：单击退出翻译，长按打开菜单（看原文 / 语言 / 复制 / 回复 / 重译 / 关闭）；返回键也直接退出（先收起打开的面板）。

interface OpenMsg {
  mode: 'translate' | 'quick'
  density: number
  orb: { x: number; y: number; size: number }
  side: 'left' | 'right'
  /** 状态栏、底部导航条（CSS 像素） */
  insets: { top: number; bottom: number }
  settings: MobileSettings
  frame?: { id: number; w: number; h: number; content: Rect }
}

interface OcrResult {
  frame: number
  lines: OcrLine[]
  ms: number
  timing: Record<string, number>
  image: { base64: string; mediaType: 'image/png' | 'image/jpeg'; width: number; height: number; factor: number }
}

type Stage = 'hidden' | 'translate' | 'quick'
type Sheet = 'lang' | null

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const haptic = (kind: 'tick' | 'long' | 'confirm') => notify('haptic', { kind })

export function MobileOverlay() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const pixels = useRef<Uint8Array | null>(null)
  const [stage, setStage] = useState<Stage>('hidden')
  const [closing, setClosing] = useState(false)
  const [shown, setShown] = useState(false)
  const [sess, setSess] = useState<OpenMsg | null>(null)
  const sessRef = useRef<OpenMsg | null>(null)
  const settings = useRef<MobileSettings | null>(null)
  const [insets, setInsets] = useState({ top: 24, bottom: 16, ime: 0 })
  const [vw, setVw] = useState(window.innerWidth)
  const [vh, setVh] = useState(window.innerHeight)

  // 翻译状态
  const reqId = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const ocrRef = useRef<OcrResult | null>(null)
  const [lines, setLines] = useState<OcrLine[]>([])
  const [blocks, setBlocks] = useState<TranslatedBlock[]>([])
  const [colors, setColors] = useState<Record<number, BlockColors>>({})
  const [phase, setPhase] = useState<Phase>('idle')
  const [lang, setLang] = useState<{ code: string; name: string; chat?: boolean } | null>(null)
  const [error, setError] = useState<{ message: string; code?: ErrorCode } | null>(null)
  const [stats, setStats] = useState<{ ms: number; engine: string } | null>(null)
  const [target, setTarget] = useState('zh-Hans')

  // 界面
  const [menu, setMenu] = useState(false)
  const [peek, setPeek] = useState(false)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [replyOpen, setReplyOpen] = useState(false)
  const [tone, setTone] = useState<MobileSettings['replyTone']>('auto')
  const replyDraft = useRef('')
  const quickDraft = useRef('')
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [pillOpen, setPillOpen] = useState(true)

  useEffect(() => installReplyHost(() => settings.current), [])

  const flash = useCallback((text: string) => {
    const id = Date.now()
    setToast({ id, text })
    window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 1500)
  }, [])

  // ------------------------------------------------------------ 打开 / 关闭
  const reset = useCallback(() => {
    reqId.current++
    abort.current?.abort()
    abort.current = null
    ocrRef.current = null
    setLines([])
    setBlocks([])
    setColors({})
    setPhase('idle')
    setLang(null)
    setError(null)
    setStats(null)
    setMenu(false)
    setPeek(false)
    setSheet(null)
    setReplyOpen(false)
    setToast(null)
    setPillOpen(true)
    setClosing(false)
    replyDraft.current = ''
    quickDraft.current = ''
  }, [])

  const close = useCallback(async () => {
    if (closing) return
    setClosing(true)
    reqId.current++
    abort.current?.abort()
    ;(window as unknown as { lens?: { replyCancel(): void } }).lens?.replyCancel()
    await new Promise((r) => setTimeout(r, 170))
    await call('close').catch(() => {})
    setStage('hidden')
    setShown(false)
    setSess(null)
    sessRef.current = null
    pixels.current = null
    const c = canvas.current
    if (c) {
      c.width = 1
      c.height = 1
    }
    reset()
  }, [closing, reset])

  const startTranslate = useCallback(async (opts: { reuseOcr?: boolean; lang?: string } = {}) => {
    const s = sessRef.current
    const st = settings.current
    if (!s?.frame || !st) return
    const id = ++reqId.current
    abort.current?.abort()
    const ctl = (abort.current = new AbortController())
    const t0 = performance.now()
    setBlocks([])
    setError(null)
    setStats(null)
    setLang(null)
    setPillOpen(true)

    let ocr = opts.reuseOcr ? ocrRef.current : null
    if (!ocr) {
      setPhase('ocr')
      try {
        ocr = await call<OcrResult>('ocr', { frame: s.frame.id })
      } catch (e) {
        if (id !== reqId.current) return
        setPhase('error')
        setError({ message: (e as Error).message, code: 'unknown' })
        return
      }
      if (id !== reqId.current) return
      ocrRef.current = ocr
      console.info('[lava] ocr', JSON.stringify({ lines: ocr.lines.length, ms: ocr.ms, ...ocr.timing, wait: Math.round(performance.now() - t0) }))
      const px = pixels.current
      const f = s.frame
      if (px) {
        const cs: Record<number, BlockColors> = {}
        for (const l of ocr.lines) cs[l.id] = sampleColors(px, f.w, f.h, { x: l.box.x + f.content.x, y: l.box.y + f.content.y, w: l.box.w, h: l.box.h }, l.box.h)
        setColors(cs)
      }
      setLines(ocr.lines)
    }
    if (!ocr.lines.length) {
      setPhase('error')
      setError({ message: '没有识别到文字', code: 'no-text' })
      return
    }
    const eng = engineFor(st)
    if (!eng) {
      setPhase('error')
      setError({ message: engineProblem(st) ?? '翻译服务还没有配置', code: 'config' })
      return
    }
    setPhase('translating')
    const tgt = LANGUAGES.find((l) => l.code === (opts.lang ?? st.targetLang)) ?? LANGUAGES[0]
    const { factor, ...image } = ocr.image
    const promptLines = factor === 1 ? ocr.lines : ocr.lines.map((l) => ({ ...l, box: { x: l.box.x * factor, y: l.box.y * factor, w: l.box.w * factor, h: l.box.h * factor } }))
    try {
      const res = await eng.translate(
        { image, lines: promptLines, target: tgt, styleHint: st.styleHint },
        (ev) => {
          if (id !== reqId.current) return
          if (ev.type === 'lang') setLang({ code: ev.code, name: ev.name, chat: ev.chat })
          else if (ev.type === 'block') setBlocks((bs) => [...bs, ev.block])
        },
        ctl.signal
      )
      if (id !== reqId.current) return
      setPhase('done')
      setStats({ ms: performance.now() - t0, engine: eng.name })
      console.info('[lava] done', JSON.stringify({ total: Math.round(performance.now() - t0), engine: eng.name, ...res }))
      haptic('confirm')
      window.setTimeout(() => setPillOpen(false), Number(localStorage.getItem('lava.tipShown') ?? 0) < 3 ? 4200 : 2600)
    } catch (e) {
      if (id !== reqId.current || ctl.signal.aborted) return
      const err = e as Error & { code?: ErrorCode }
      setPhase('error')
      setError({ message: err.message, code: err.code })
    }
  }, [])

  const open = useCallback(
    async (o: OpenMsg) => {
      reset()
      sessRef.current = o
      settings.current = o.settings
      setSess(o)
      setTarget(o.settings.targetLang)
      setTone(o.settings.replyTone)
      setVw(window.innerWidth)
      setVh(window.innerHeight)
      setInsets((v) => ({ ...v, top: o.insets.top, bottom: o.insets.bottom }))
      // OCR 的同时先和翻译服务建立连接
      engineFor(o.settings)?.warm()
      if (o.mode === 'quick') {
        setStage('quick')
        await raf()
        await raf()
        await call('shown').catch(() => {})
        setShown(true)
        return
      }
      const f = o.frame!
      const buf = new Uint8Array(await (await fetch(`/frame/${f.id}`)).arrayBuffer())
      if (sessRef.current !== o) return
      pixels.current = buf
      const c = canvas.current!
      c.width = f.w
      c.height = f.h
      c.getContext('2d', { alpha: false })!.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength), f.w, f.h), 0, 0)
      setStage('translate')
      // 截图画好后再让窗口可见：看起来和原来的屏幕一模一样
      await raf()
      await raf()
      await call('shown').catch(() => {})
      setShown(true)
      void startTranslate()
    },
    [reset, startTranslate]
  )

  // 返回键：先收起最上层的东西
  const back = useRef<() => void>(() => {})
  back.current = () => {
    if (menu) return setMenu(false)
    if (sheet) return setSheet(null)
    if (replyOpen) return setReplyOpen(false)
    void close()
  }

  useEffect(() => {
    void call('hello').catch(() => {})
    const offs = [
      on<OpenMsg>('open', (o) => void open(o)),
      on('back', () => back.current()),
      on<{ top: number; bottom: number; ime: number }>('insets', (v) => setInsets(v)),
    ]
    const resize = () => {
      setVw(window.innerWidth)
      setVh(window.innerHeight)
    }
    window.addEventListener('resize', resize)
    return () => {
      offs.forEach((f) => f())
      window.removeEventListener('resize', resize)
    }
  }, [open])

  // 调试：在 DevTools 里查看当前识别、翻译结果
  useEffect(() => {
    ;(window as unknown as { __lava: object }).__lava = { lines, blocks, colors, phase }
  }, [lines, blocks, colors, phase])

  // ------------------------------------------------------------ 操作
  const allText = useCallback(() => blocks.map((b) => (b.keep ? b.source : b.translation)).join('\n'), [blocks])

  const copyAll = () => {
    if (!blocks.length) return
    notify('copy', { text: allText() })
    haptic('confirm')
    flash('已复制全部译文')
  }

  const tapLayer = (e: React.MouseEvent) => {
    if (menu) return setMenu(false)
    const key = (e.target as HTMLElement).closest<HTMLElement>('[data-block]')?.dataset.block
    const b = key && blocks.find((x) => x.key === key)
    if (!b) return
    notify('copy', { text: b.keep ? b.source : b.translation })
    haptic('tick')
    flash('已复制这段译文')
  }

  const changeTarget = (code: string) => {
    setSheet(null)
    setTarget(code)
    if (settings.current) settings.current = { ...settings.current, targetLang: code }
    void call('settings', { targetLang: code }).catch(() => {})
    void startTranslate({ reuseOcr: true, lang: code })
  }

  const changeTone = (t: MobileSettings['replyTone']) => {
    setTone(t)
    if (settings.current) settings.current = { ...settings.current, replyTone: t }
    void call('settings', { replyTone: t }).catch(() => {})
  }

  const pick = (id: string) => {
    setMenu(false)
    switch (id) {
      case 'peek':
        setPeek((v) => !v)
        break
      case 'lang':
        setSheet('lang')
        break
      case 'copy':
        copyAll()
        break
      case 'reply':
        setReplyOpen(true)
        break
      case 'retry':
        void startTranslate({ reuseOcr: !!ocrRef.current })
        break
      case 'close':
        void close()
        break
    }
  }

  const items: OrbItem[] = [
    { id: 'peek', label: peek ? '看译文' : '看原文', icon: peek ? <EyeOff size={19} /> : <Eye size={19} />, active: peek, disabled: !blocks.length },
    { id: 'lang', label: '语言', icon: <Languages size={19} /> },
    { id: 'copy', label: '复制', icon: <Copy size={18} />, disabled: !blocks.length },
    { id: 'reply', label: '回复', icon: <MessageSquareReply size={19} /> },
    { id: 'retry', label: '重译', icon: <RotateCcw size={18} /> },
    { id: 'close', label: '关闭', icon: <X size={20} /> }
  ]

  // ------------------------------------------------------------ 布局
  const d = sess?.density ?? window.devicePixelRatio
  const f = sess?.frame
  const covered = useMemo(() => new Set(blocks.flatMap((b) => b.lineIds)), [blocks])
  const pending = useMemo(() => (phase === 'translating' ? new Set(lines.filter((l) => !covered.has(l.id)).map((l) => l.id)) : null), [phase, lines, covered])
  const progress = { done: lines.filter((l) => covered.has(l.id)).length, total: lines.length }
  const targetName = LANGUAGES.find((l) => l.code === target)?.name ?? target
  const replyContext = useMemo(() => {
    const t = blocks.map((b) => b.source).join('\n')
    return t.length > 3000 ? t.slice(-3000) : t
  }, [blocks])
  const keyboard = insets.ime > 0
  // 前几次翻译完成时提示：单击悬浮球退出、长按打开菜单
  const showTip = useMemo(() => phase === 'done' && Number(localStorage.getItem('lava.tipShown') ?? 0) < 3, [phase])
  useEffect(() => {
    if (showTip) localStorage.setItem('lava.tipShown', String(Number(localStorage.getItem('lava.tipShown') ?? 0) + 1))
  }, [showTip])
  const sheetBottom = (keyboard ? insets.ime : insets.bottom) + 10
  const showCta = stage === 'translate' && !!lang?.chat && !!settings.current?.replyAssist && !replyOpen && !menu && !sheet && (phase === 'translating' || phase === 'done')

  if (stage === 'hidden')
    return (
      <div className="m-root hidden">
        <canvas ref={canvas} className="m-shot" />
      </div>
    )

  return (
    <div className={`m-root ${stage}${closing ? ' closing' : ''}${shown ? ' shown' : ''}`}>
      <canvas ref={canvas} className="m-shot" style={f ? { width: f.w / d, height: f.h / d } : undefined} />

      {stage === 'quick' && <div className="m-dim" onClick={() => void close()} />}

      {f && (
        <div className="m-layer" style={{ left: f.content.x / d, top: f.content.y / d }} onClick={tapLayer}>
          <TranslationLayer
            lines={lines}
            blocks={blocks}
            colors={colors}
            scale={d}
            width={f.content.w / d}
            height={f.content.h / d}
            targetLang={target}
            peek={peek}
            pending={pending}
          />
          {phase === 'ocr' && <div className="m-scan" />}
        </div>
      )}

      {/* 状态：识别中 / 翻译进度 / 完成用时 / 出错 */}
      <AnimatePresence>
        {shown && stage === 'translate' && (pillOpen || phase === 'error') && !closing && !peek && (
          <motion.div
            className={`m-pill${phase === 'error' ? ' error' : ''}`}
            style={{ top: insets.top + 8 }}
            initial={{ opacity: 0, y: -12, x: '-50%', scale: 0.96 }}
            animate={{ opacity: 1, y: 0, x: '-50%', scale: 1 }}
            exit={{ opacity: 0, y: -10, x: '-50%', transition: { duration: 0.2 } }}
            transition={{ type: 'spring', stiffness: 460, damping: 32 }}
            layout
          >
            {phase === 'ocr' && (
              <>
                <span className="m-spin" />
                识别文字
              </>
            )}
            {phase === 'translating' && (
              <>
                <span className="m-spin" />
                {lang ? `${lang.name} → ${targetName}` : '翻译中'}
                <span className="m-pill-num">
                  {progress.done}/{progress.total}
                </span>
              </>
            )}
            {phase === 'done' && (
              <>
                <Check size={14} strokeWidth={3} className="m-ok" />
                {lang ? `${lang.name} → ${targetName}` : '完成'}
                {stats && <span className="m-pill-num">{(stats.ms / 1000).toFixed(1)} s</span>}
                {showTip && <span className="m-pill-tip">单击悬浮球退出 · 长按打开菜单</span>}
              </>
            )}
            {phase === 'error' && error && (
              <>
                <span className="m-pill-err">{error.message}</span>
                {error.code === 'config' || error.code === 'auth' ? (
                  <button className="m-pill-btn" onClick={() => void call('openSettings')}>
                    <Settings2 size={13} /> 去设置
                  </button>
                ) : error.code !== 'no-text' ? (
                  <button className="m-pill-btn" onClick={() => void startTranslate({ reuseOcr: !!ocrRef.current })}>
                    <RotateCcw size={13} /> 重试
                  </button>
                ) : null}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 正在看原文：点一下回到译文 */}
      <AnimatePresence>
        {peek && !closing && (
          <motion.button
            className="m-peek"
            style={{ top: insets.top + 8 }}
            initial={{ opacity: 0, y: -10, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: -8, x: '-50%', transition: { duration: 0.15 } }}
            transition={{ type: 'spring', stiffness: 460, damping: 32 }}
            onClick={() => setPeek(false)}
          >
            <Eye size={14} /> 正在显示原文 · 点这里看译文
          </motion.button>
        )}
      </AnimatePresence>

      {/* 菜单打开时稍微压暗，点空白处收起 */}
      <AnimatePresence>
        {menu && <motion.div className="m-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMenu(false)} />}
      </AnimatePresence>

      {sess && stage === 'translate' && !closing && (
        <Orb
          x={sess.orb.x}
          y={sess.orb.y}
          size={sess.orb.size}
          vw={vw}
          vh={vh}
          safeTop={insets.top}
          safeBottom={insets.bottom}
          phase={phase}
          progress={progress}
          menu={menu}
          items={items}
          onTap={() => (menu ? setMenu(false) : void close())}
          onMenu={() => setMenu(true)}
          onPick={pick}
          onMoved={(side, y) => {
            setSess((s) => (s ? { ...s, side, orb: { ...s.orb, y, x: side === 'left' ? 6 : vw - 6 - s.orb.size } } : s))
            notify('orb', { side, y })
          }}
          haptic={haptic}
        />
      )}

      {/* 聊天截图：提示可以直接回复 */}
      <AnimatePresence>
        {showCta && (
          <motion.button
            className="m-cta"
            style={{ bottom: insets.bottom + 18 }}
            initial={{ opacity: 0, y: 16, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 12, x: '-50%', transition: { duration: 0.15 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 30, delay: 0.25 }}
            onClick={() => setReplyOpen(true)}
          >
            <MessageSquareReply size={16} />
            <span>
              用{targetName}回复
              <small>自动译成{lang?.name}</small>
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* 回复助手 / 输入翻译 */}
      <AnimatePresence>
        {((stage === 'translate' && replyOpen) || (stage === 'quick' && shown)) && !closing && (
          <ReplyComposer
            key={stage}
            quick={stage === 'quick'}
            style={{ left: 10, right: 10, bottom: sheetBottom }}
            menuUp
            userLang={target}
            peer={stage === 'quick' ? null : lang}
            context={stage === 'quick' ? '' : replyContext}
            tone={tone}
            draft={stage === 'quick' ? quickDraft : replyDraft}
            onTone={changeTone}
            onCollapse={() => (stage === 'quick' ? void close() : setReplyOpen(false))}
            onExit={() => void close()}
            onCopied={(andClose) => {
              haptic('confirm')
              if (andClose) void close()
            }}
          />
        )}
      </AnimatePresence>

      {/* 目标语言 */}
      <AnimatePresence>
        {sheet === 'lang' && (
          <>
            <motion.div className="m-scrim top" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSheet(null)} />
            <motion.div
              className="m-sheet"
              style={{ paddingBottom: insets.bottom + 14 }}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%', transition: { duration: 0.2 } }}
              transition={{ type: 'spring', stiffness: 420, damping: 38 }}
            >
              <div className="m-sheet-grip" />
              <div className="m-sheet-title">译成</div>
              <div className="m-langs">
                {LANGUAGES.map((l) => (
                  <button key={l.code} className={`m-lang${l.code === target ? ' on' : ''}`} onClick={() => changeTarget(l.code)}>
                    <span>{l.name}</span>
                    <span className="m-lang-native">{l.native}</span>
                  </button>
                ))}
              </div>
              <button className="m-sheet-link" onClick={() => void call('openSettings')}>
                <Settings2 size={14} /> 翻译服务设置
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            className="m-toast"
            style={{ top: insets.top + 56 }}
            initial={{ opacity: 0, y: -6, scale: 0.94, x: '-50%' }}
            animate={{ opacity: 1, y: 0, scale: 1, x: '-50%' }}
            exit={{ opacity: 0, y: -6, x: '-50%', transition: { duration: 0.15 } }}
            transition={{ type: 'spring', stiffness: 560, damping: 30 }}
          >
            <Check size={14} strokeWidth={3} />
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
