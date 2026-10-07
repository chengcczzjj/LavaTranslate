import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Check, ChevronDown, Copy, CornerDownLeft, Languages, MessageSquareReply, RotateCcw, X } from 'lucide-react'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { LANGUAGES, type Settings } from '@shared/types'
import './reply.css'

// 回复助手：看懂对方的消息后，直接用自己的语言写回复，译成对方的语言，一键复制去发送
// 快速输入（quick）：连按两次快捷键打开，不框选，直接输入一句话翻译成上次的目标语言

type Tone = Settings['replyTone']
type Status = 'idle' | 'streaming' | 'done' | 'error'

export interface ReplyProps {
  style: React.CSSProperties
  /** 用户自己的语言（截图翻译的目标语言） */
  userLang: string
  /** 对方的语言（截图识别出的语言） */
  peer: { code: string; name: string } | null
  /** 屏幕上的对话原文，让模型跟随语气、称呼 */
  context: string
  tone: Tone
  /** 草稿：收起再打开时保留 */
  draft: React.MutableRefObject<string>
  /** 语言菜单向上展开（回复框贴着屏幕底部时） */
  menuUp: boolean
  /** 快速输入模式 */
  quick?: boolean
  onTone: (t: Tone) => void
  /** 收起回复框 */
  onCollapse: () => void
  /** 退出截图 */
  onExit: () => void
  /** 已复制；close 表示随后关闭截图界面 */
  onCopied: (close: boolean) => void
}

const TONES: { id: Tone; label: string; tip: string }[] = [
  { id: 'auto', label: '跟随语境', tip: '参照对话里双方的语气' },
  { id: 'formal', label: '正式', tip: '礼貌、书面' },
  { id: 'casual', label: '随意', tip: '口语、亲切' }
]

const MARK = '⟲'
const HISTORY_KEY = 'lens.reply.history'
const LAST_TO_KEY = 'lens.reply.lastTo'
/** 停顿多久才开始翻译：不追求实时，等一句话写完再翻（Enter 立即翻译） */
const DEBOUNCE = { reply: 1800, quick: 2200 }
let seq = 0

export function langBase(code: string) {
  const c = code.toLowerCase()
  if (c.startsWith('zh')) return /(tw|hk|mo|hant)/.test(c) ? 'zh-hant' : 'zh-hans'
  return c.split(/[-_]/)[0]
}

function findLang(code: string) {
  return LANGUAGES.find((l) => langBase(l.code) === langBase(code))
}

/** 流式输出拆成「译文」与「回译」；流到一半的分隔符不显示 */
function split(raw: string) {
  const i = raw.indexOf(MARK)
  if (i < 0) return { text: raw.replace(/\s+$/, ''), back: '' }
  return { text: raw.slice(0, i).trim(), back: raw.slice(i + 1).trim() }
}

function readHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export const ReplyComposer = forwardRef<HTMLDivElement, ReplyProps>(function ReplyComposer(p, ref) {
  const user = findLang(p.userLang)
  const userName = user?.name ?? p.userLang

  // 对方语言：默认取截图识别结果；截图本身就是自己的语言时，沿用上次的回复语言
  const autoTo = useMemo(() => {
    if (p.peer && langBase(p.peer.code) !== langBase(p.userLang)) return p.peer.code
    const last = localStorage.getItem(LAST_TO_KEY)
    if (last && langBase(last) !== langBase(p.userLang)) return last
    return langBase(p.userLang) === 'en' ? 'zh-Hans' : 'en'
  }, [p.peer, p.userLang])
  const [picked, setPicked] = useState<string | null>(null)
  const to = picked ?? autoTo
  const toName = findLang(to)?.name ?? (p.peer && langBase(p.peer.code) === langBase(to) ? p.peer.name : to)

  const [text, setText] = useState(p.draft.current)
  const [raw, setRaw] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [shownKey, setShownKey] = useState('')
  const [copied, setCopied] = useState(false)
  const [menu, setMenu] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const req = useRef(0)
  const timer = useRef(0)
  const composing = useRef(false)
  const after = useRef<'close' | 'stay' | null>(null)
  const histIdx = useRef(-1)

  const keyOf = (t: string, l: string, tone: Tone) => `${langBase(l)}|${tone}|${t.trim()}`
  const key = keyOf(text, to, p.tone)
  const { text: out, back } = split(raw)
  const busy = status === 'streaming'
  const stale = !!text.trim() && shownKey !== key
  const fresh = status === 'done' && !stale && !!out

  // 异步回调里要读最新值
  const live = useRef({ raw, text, to, p })
  live.current = { raw, text, to, p }

  const translate = (t: string, l = to, tone = p.tone) => {
    window.clearTimeout(timer.current)
    timer.current = 0
    if (!t.trim()) {
      req.current = ++seq
      window.lens.replyCancel()
      setRaw('')
      setStatus('idle')
      setShownKey('')
      return
    }
    const id = (req.current = ++seq)
    setStatus('streaming')
    setError('')
    setRaw('')
    setShownKey(keyOf(t, l, tone))
    const name = findLang(l)?.name ?? (p.peer && langBase(p.peer.code) === langBase(l) ? p.peer.name : undefined)
    window.lens.replyStart({ requestId: id, text: t.trim(), to: l, toName: name, tone, context: p.context, quick: p.quick })
  }

  const copy = (close: boolean) => {
    const value = split(live.current.raw).text
    if (!value) return
    window.lens.copyText(value)
    setCopied(true)
    const t = live.current.text.trim()
    localStorage.setItem(HISTORY_KEY, JSON.stringify([t, ...readHistory().filter((h) => h !== t)].slice(0, 30)))
    localStorage.setItem(LAST_TO_KEY, live.current.to)
    // 关闭前留一瞬间给「已复制」的反馈
    if (close) window.setTimeout(() => live.current.p.onCopied(true), 220)
    else {
      live.current.p.onCopied(false)
      window.setTimeout(() => setCopied(false), 1500)
    }
  }

  useEffect(() => {
    const off = window.lens.onReply(({ requestId, event }) => {
      if (requestId !== req.current) return
      if (event.type === 'delta') setRaw((r) => r + event.text)
      else if (event.type === 'done') {
        setStatus('done')
        const then = after.current
        after.current = null
        if (then) window.setTimeout(() => copy(then === 'close'), 0)
      } else {
        setStatus('error')
        setError(event.message)
        after.current = null
      }
    })
    // 重新打开时有草稿，接着翻译
    if (p.draft.current.trim()) translate(p.draft.current)
    const f = window.setTimeout(() => {
      const el = input.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 40)
    return () => {
      off()
      window.clearTimeout(f)
      window.clearTimeout(timer.current)
      window.lens.replyCancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 重新识别后对方语言变了：没手动选过就跟着变
  const autoRef = useRef(autoTo)
  useEffect(() => {
    if (autoRef.current === autoTo) return
    autoRef.current = autoTo
    if (!picked && text.trim()) translate(text, autoTo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTo])

  const edit = (v: string) => {
    setText(v)
    p.draft.current = v
    if (composing.current) return
    window.clearTimeout(timer.current)
    if (!v.trim()) return translate('')
    if (keyOf(v, to, p.tone) === shownKey && status !== 'error') return
    timer.current = window.setTimeout(() => translate(v), p.quick ? DEBOUNCE.quick : DEBOUNCE.reply)
  }

  const submit = (mode: 'close' | 'stay') => {
    if (!text.trim()) return
    if (fresh) return copy(mode === 'close')
    // 还没翻完：翻译完成后自动复制
    after.current = mode
    if (!(busy && !stale)) translate(text)
  }

  const recall = (v: string) => {
    setText(v)
    p.draft.current = v
    translate(v)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || composing.current) return e.stopPropagation()
    const empty = !text
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (menu) setMenu(false)
      else if (empty) p.onExit()
      else p.onCollapse()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !empty) {
      e.preventDefault()
      e.stopPropagation()
      return submit(e.ctrlKey || e.metaKey ? 'stay' : 'close')
    }
    // ↑ / ↓ 翻看发过的回复
    if (e.key === 'ArrowUp' && plain && !e.shiftKey && (empty || histIdx.current >= 0)) {
      e.stopPropagation()
      const hist = readHistory()
      if (!hist.length) return
      e.preventDefault()
      histIdx.current = Math.min(hist.length - 1, histIdx.current + 1)
      return recall(hist[histIdx.current])
    }
    if (e.key === 'ArrowDown' && plain && !e.shiftKey && histIdx.current >= 0) {
      e.preventDefault()
      e.stopPropagation()
      histIdx.current--
      return recall(histIdx.current >= 0 ? (readHistory()[histIdx.current] ?? '') : '')
    }
    histIdx.current = -1
    // 输入框为空时，空格（按住看原文）、Enter（复制截图译文）、Tab（切换显示）仍交给截图界面
    if (empty && plain && (e.key === ' ' || e.key === 'Enter' || e.key === 'Tab')) return
    if (e.key === 'Tab') {
      e.preventDefault()
      return e.stopPropagation()
    }
    // 打字、编辑类按键留在输入框；功能键与其余组合键（复制截图、保存、F3 钉图…）交给截图界面
    const k = e.key.toLowerCase()
    const editKeys = ['backspace', 'delete', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'pageup', 'pagedown', 'enter']
    if (e.ctrlKey || e.metaKey) {
      if (['a', 'z', 'y', 'x', 'v', ...editKeys].includes(k)) e.stopPropagation()
    } else if (!e.altKey && (e.key.length === 1 || editKeys.includes(k))) e.stopPropagation()
  }

  const pickLang = (code: string) => {
    setMenu(false)
    setPicked(code)
    localStorage.setItem(LAST_TO_KEY, code)
    if (text.trim()) translate(text, code)
    input.current?.focus()
  }

  const pickTone = (t: Tone) => {
    p.onTone(t)
    if (text.trim()) translate(text, to, t)
    input.current?.focus()
  }

  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.rp-langs, .rp-to')) setMenu(false)
    }
    window.addEventListener('mousedown', away, true)
    return () => window.removeEventListener('mousedown', away, true)
  }, [menu])

  const langs = useMemo(() => {
    const list = LANGUAGES.filter((l) => langBase(l.code) !== langBase(p.userLang))
    // 识别出的语言不在常用列表里（如印尼语）时补上
    if (p.peer && !findLang(p.peer.code) && langBase(p.peer.code) !== langBase(p.userLang))
      list.unshift({ code: p.peer.code, name: p.peer.name, native: p.peer.name })
    return list
  }, [p.userLang, p.peer])

  const hasOut = status !== 'idle'
  const hasHistory = !text && readHistory().length > 0

  return (
    <motion.div
      ref={ref}
      className="reply"
      style={p.style}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      initial={{ opacity: 0, y: -10, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.14 } }}
      transition={{ type: 'spring', stiffness: 440, damping: 34 }}
    >
      <div className="rp-head">
        <span className="rp-title">
          {p.quick ? <Languages size={15} /> : <MessageSquareReply size={15} />}
          {p.quick ? '翻译' : '回复'}
        </span>
        <div className="rp-route">
          <span className="rp-from">{userName}</span>
          <ArrowRight size={12} className="rp-arrow" />
          <button className={`rp-to${menu ? ' open' : ''}`} onClick={() => setMenu((v) => !v)}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={toName}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
                {toName}
              </motion.span>
            </AnimatePresence>
            <ChevronDown size={12} className="rp-chev" />
          </button>
          <AnimatePresence>
            {menu && (
              <motion.div
                className={`rp-langs ${p.menuUp ? 'up' : 'down'}`}
                initial={{ opacity: 0, y: p.menuUp ? 6 : -6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: p.menuUp ? 4 : -4, transition: { duration: 0.1 } }}
                transition={{ type: 'spring', stiffness: 560, damping: 36 }}
              >
                <div className="rp-langs-label">译成</div>
                <div className="rp-langs-grid">
                  {langs.map((l) => (
                    <button key={l.code} className={`rp-lang${langBase(l.code) === langBase(to) ? ' on' : ''}`} onClick={() => pickLang(l.code)}>
                      <span>{l.name}</span>
                      <span className="rp-native">{l.native}</span>
                      {p.peer && langBase(p.peer.code) === langBase(l.code) && <span className="rp-detected">对方</span>}
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="rp-tones">
          {TONES.map((t) => (
            <button key={t.id} className={`rp-tone${p.tone === t.id ? ' on' : ''}`} title={t.tip} onClick={() => pickTone(t.id)}>
              {p.tone === t.id && <motion.span layoutId="rp-tone-pill" className="rp-tone-pill" transition={{ type: 'spring', stiffness: 620, damping: 42 }} />}
              <span className="rp-tone-label">{t.label}</span>
            </button>
          ))}
        </div>
        <button className="rp-x" title="收起" onClick={p.onCollapse}>
          <X size={14} />
        </button>
      </div>

      <textarea
        ref={input}
        className="rp-input"
        value={text}
        rows={1}
        spellCheck={false}
        placeholder={p.quick ? `输入要翻译的文字，停顿片刻自动译成${toName}` : `用${userName}写下你想回复的话，停顿片刻自动译成${toName}`}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={(e) => {
          composing.current = false
          edit((e.target as HTMLTextAreaElement).value)
        }}
      />

      <AnimatePresence initial={false}>
        {hasOut && (
          <motion.div
            key="out"
            className="rp-out-wrap"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 38 }}
          >
            <div className={`rp-out${busy ? ' busy' : ''}${stale && !busy ? ' stale' : ''}${copied ? ' copied' : ''}`}>
              <div className="rp-flow" />
              {status === 'error' ? (
                <div className="rp-err">
                  <span>{error}</span>
                  <button onClick={() => translate(text)}>
                    <RotateCcw size={12} /> 重试
                  </button>
                </div>
              ) : (
                <>
                  <div
                    className={`rp-text${out ? '' : ' wait'}`}
                    title={out && !busy ? '点击复制' : undefined}
                    onClick={() => out && !busy && copy(false)}
                    lang={to}
                  >
                    {out || '正在翻译…'}
                    {busy && out && <span className="rp-caret" />}
                  </div>
                  <AnimatePresence initial={false}>
                    {back && (
                      <motion.div
                        className="rp-back"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <span className="rp-back-tag" title="把译文再翻回你的语言，确认意思没有走样">
                          回译
                        </span>
                        <span className="rp-back-text">{back}</span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="rp-foot">
        <span className="rp-hint">
          {text ? (
            <>
              <kbd>Enter</kbd> 复制并关闭
              <i />
              <kbd>Ctrl</kbd>
              <kbd>Enter</kbd> 只复制
            </>
          ) : (
            <>
              {hasHistory && (
                <>
                  <kbd>↑</kbd> 上一条
                  <i />
                </>
              )}
              <kbd>Esc</kbd> {p.quick ? '退出' : '退出截图'}
            </>
          )}
        </span>
        <button className={`rp-btn${copied ? ' ok' : ''}`} disabled={!out || busy || (stale && !copied)} onClick={() => copy(false)}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={copied ? 'ok' : 'cp'}
              className="rp-btn-in"
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              transition={{ type: 'spring', stiffness: 700, damping: 32 }}
            >
              {copied ? <Check size={14} strokeWidth={3} /> : <Copy size={13} />}
              {copied ? '已复制' : '复制'}
            </motion.span>
          </AnimatePresence>
        </button>
        <button className={`rp-btn primary${fresh ? ' ready' : ''}`} disabled={!text.trim()} onClick={() => submit('close')}>
          复制并关闭
          <CornerDownLeft size={13} />
        </button>
      </div>
    </motion.div>
  )
})
