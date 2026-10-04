import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Columns2,
  Copy,
  Download,
  Eye,
  ImageDown,
  Layers,
  MessageSquareReply,
  Pin,
  RotateCw,
  Search,
  Settings2,
  X
} from 'lucide-react'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { LANGUAGES, type ErrorCode, type Phase } from '@shared/types'
import { Tip } from '../components/Tip'

export interface ToolbarProps {
  phase: Phase
  error: { message: string; code?: ErrorCode } | null
  lang: { code: string; name: string } | null
  target: string
  progress: { done: number; total: number }
  stats: { ms: number; firstTokenMs?: number; engine: string } | null
  mode: 'overlay' | 'side'
  peek: boolean
  pickerUp: boolean
  onTarget: (code: string) => void
  onMode: (m: 'overlay' | 'side') => void
  onPeek: (on: boolean) => void
  onCopy: () => void
  onCopyImage: () => void
  onPin: () => void
  onSave: () => void
  onRetry: () => void
  onSettings: () => void
  onClose: () => void
  reply: boolean
  onReply: () => void
}

export const Toolbar = forwardRef<HTMLDivElement, ToolbarProps & { style: React.CSSProperties }>(function Toolbar(p, ref) {
  const [picker, setPicker] = useState(false)
  const targetName = LANGUAGES.find((l) => l.code === p.target)?.name ?? p.target
  const busy = p.phase === 'ocr' || p.phase === 'translating'
  const ready = p.phase === 'done'
  const pct = p.phase === 'ocr' ? 0.08 : p.progress.total ? 0.12 + (0.88 * p.progress.done) / p.progress.total : 0.12

  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && picker) {
        e.stopPropagation()
        setPicker(false)
      }
    }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [picker])

  return (
    <motion.div
      ref={ref}
      className="toolbar"
      style={p.style}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.8 }}
    >
      {/* 状态 + 语言 */}
      <div className="tb-status">
        <StatusIcon phase={p.phase} />
        {p.phase === 'error' && p.error ? (
          <span className="tb-error" title={p.error.message}>
            {p.error.message}
          </span>
        ) : (
          <button className={`tb-lang${picker ? ' is-open' : ''}`} onClick={() => setPicker((v) => !v)}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={p.lang?.name ?? (p.phase === 'ocr' ? 'ocr' : 'auto')}
                className="tb-src"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              >
                {p.lang?.name ?? (p.phase === 'ocr' ? '识别中' : '自动检测')}
              </motion.span>
            </AnimatePresence>
            <ArrowRight size={13} className="tb-arrow" />
            <span className="tb-dst">{targetName}</span>
            <ChevronDown size={13} className="tb-chev" />
          </button>
        )}
        <AnimatePresence>
          {p.phase === 'translating' && p.progress.total > 0 && (
            <motion.span
              className="tb-count"
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
            >
              {p.progress.done}/{p.progress.total}
            </motion.span>
          )}
          {ready && p.stats && (
            <motion.span className="tb-time" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              {(p.stats.ms / 1000).toFixed(1)}s
            </motion.span>
          )}
        </AnimatePresence>
        {p.phase === 'error' && (p.error?.code === 'auth' || p.error?.code === 'config') && (
          <button className="tb-pill" onClick={p.onSettings}>
            <Settings2 size={13} /> 去设置
          </button>
        )}
        {p.phase === 'error' && !['auth', 'config', 'no-text'].includes(p.error?.code ?? '') && (
          <button className="tb-pill" onClick={p.onRetry}>
            <RotateCw size={13} /> 重试
          </button>
        )}
      </div>

      <div className="tb-sep" />

      <div className="tb-seg">
        <motion.div className="tb-seg-thumb" animate={{ x: p.mode === 'overlay' ? 0 : 32 }} transition={{ type: 'spring', stiffness: 600, damping: 40 }} />
        <Tip label="原位覆盖" keys="Tab">
          <button className={`tb-seg-btn${p.mode === 'overlay' ? ' on' : ''}`} onClick={() => p.onMode('overlay')}>
            <Layers size={16} />
          </button>
        </Tip>
        <Tip label="并排对照" keys="Tab">
          <button className={`tb-seg-btn${p.mode === 'side' ? ' on' : ''}`} onClick={() => p.onMode('side')}>
            <Columns2 size={16} />
          </button>
        </Tip>
      </div>

      <Tip label="按住查看原文" keys="Space">
        <button
          className={`tb-btn${p.peek ? ' on' : ''}`}
          disabled={p.mode === 'side'}
          onMouseDown={() => p.onPeek(true)}
          onMouseUp={() => p.onPeek(false)}
          onMouseLeave={() => p.peek && p.onPeek(false)}
        >
          <Eye size={17} />
        </button>
      </Tip>

      <div className="tb-sep" />

      <Tip label="复制译文" keys="Ctrl C">
        <button className="tb-btn" disabled={!p.progress.done} onClick={p.onCopy}>
          <Copy size={16} />
        </button>
      </Tip>
      <Tip label="复制为图片" keys="Ctrl Shift C">
        <button className="tb-btn" disabled={!p.progress.done} onClick={p.onCopyImage}>
          <ImageDown size={17} />
        </button>
      </Tip>
      <Tip label="钉在桌面" keys="F3">
        <button className="tb-btn" disabled={!p.progress.done} onClick={p.onPin}>
          <Pin size={16} />
        </button>
      </Tip>
      <Tip label="保存图片" keys="Ctrl S">
        <button className="tb-btn" disabled={!p.progress.done} onClick={p.onSave}>
          <Download size={16} />
        </button>
      </Tip>

      <div className="tb-sep" />

      <Tip label={p.reply ? '收起回复' : '回复对方'} keys="R">
        <button className={`tb-btn tb-reply${p.reply ? ' on' : ''}`} onClick={p.onReply}>
          <MessageSquareReply size={16} />
        </button>
      </Tip>

      <div className="tb-sep" />

      <Tip label={busy ? '翻译中…' : '重新翻译'} keys="Ctrl R">
        <button className="tb-btn" disabled={busy} onClick={p.onRetry}>
          <RotateCw size={15} className={busy ? 'spin-slow' : ''} />
        </button>
      </Tip>
      <Tip label="设置">
        <button className="tb-btn" onClick={p.onSettings}>
          <Settings2 size={16} />
        </button>
      </Tip>
      <Tip label="关闭" keys="Esc">
        <button className="tb-btn tb-close" onClick={p.onClose}>
          <X size={17} />
        </button>
      </Tip>

      {/* 底部进度光带 */}
      <AnimatePresence>
        {busy && (
          <motion.div className="tb-progress" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.4 } }}>
            <motion.div className="tb-progress-bar" animate={{ scaleX: pct }} transition={{ type: 'spring', stiffness: 120, damping: 24 }} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {picker && (
          <LangPicker
            up={p.pickerUp}
            current={p.target}
            onPick={(c) => {
              setPicker(false)
              if (c !== p.target) p.onTarget(c)
            }}
            onClose={() => setPicker(false)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  )
})

function StatusIcon({ phase }: { phase: Phase }) {
  return (
    <span className="tb-icon">
      <AnimatePresence mode="wait" initial={false}>
        {phase === 'ocr' || phase === 'translating' ? (
          <motion.span key="busy" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }}>
            <span className="tb-spinner" style={{ display: 'block' }} />
          </motion.span>
        ) : phase === 'done' ? (
          <motion.span
            key="done"
            className="tb-done"
            initial={{ opacity: 0, scale: 0.4, rotate: -40 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 600, damping: 22 }}
          >
            <Check size={12} strokeWidth={3} />
          </motion.span>
        ) : phase === 'error' ? (
          <motion.span key="err" className="tb-err-dot" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} />
        ) : (
          <motion.span key="idle" className="tb-idle-dot" />
        )}
      </AnimatePresence>
    </span>
  )
}

function LangPicker({ up, current, onPick, onClose }: { up: boolean; current: string; onPick: (c: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? LANGUAGES.filter((l) => (l.name + l.native + l.code).toLowerCase().includes(s)) : LANGUAGES
  }, [q])
  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.lang-picker, .tb-lang')) onClose()
    }
    window.addEventListener('mousedown', away, true)
    return () => window.removeEventListener('mousedown', away, true)
  }, [onClose])
  return (
    <motion.div
      className={`lang-picker ${up ? 'up' : 'down'}`}
      initial={{ opacity: 0, y: up ? 8 : -8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: up ? 6 : -6, scale: 0.98, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 560, damping: 36 }}
    >
      <div className="lp-search">
        <Search size={14} />
        <input
          ref={input}
          value={q}
          placeholder="翻译成…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && list[0]) onPick(list[0].code)
            e.stopPropagation()
          }}
        />
      </div>
      <div className="lp-grid">
        {list.map((l, i) => (
          <motion.button
            key={l.code}
            className={`lp-item${l.code === current ? ' on' : ''}`}
            onClick={() => onPick(l.code)}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.012, 0.15), duration: 0.2 }}
          >
            <span className="lp-name">{l.name}</span>
            <span className="lp-native">{l.native}</span>
            {l.code === current && <Check size={13} className="lp-check" />}
          </motion.button>
        ))}
        {!list.length && <div className="lp-empty">没有匹配的语言</div>}
      </div>
    </motion.div>
  )
}
