import { AnimatePresence, motion } from 'motion/react'
import {
  Check,
  ChevronDown,
  Columns2,
  Copy,
  ScanText,
  Languages,
  Download,
  ImageDown,
  MessageSquareReply,
  Pause,
  Pin,
  RotateCw,
  Search,
  Settings2,
  X
} from 'lucide-react'
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react'
import { LANGUAGES, type ErrorCode, type Phase } from '@shared/types'
import { Tip } from '../components/Tip'
import { ShortcutHelp } from './ShortcutHelp'
import { useI18n } from '../lib/i18n'
import { isMac, shortcutLabel } from '../lib/desktop'

export interface ToolbarProps {
  phase: Phase
  recognized: 'ocr-only' | 'same-language' | null
  error: { message: string; code?: ErrorCode } | null
  target: string
  autoTranslate: boolean
  autoTranslateBusy: boolean
  progress: { done: number; total: number }
  mode: 'overlay' | 'side'
  /** 按着 Alt 看原文：翻译暂停 */
  paused: boolean
  pickerUp: boolean
  onTarget: (code: string) => void
  onAutoTranslate: (on: boolean) => void
  onMode: (m: 'overlay' | 'side') => void
  onCopy: () => void
  onCopySource: () => void
  onCopyImage: () => void
  onPin: (original: boolean) => void
  onSave: () => void
  onRetry: () => void
  onSettings: () => void
  onClose: () => void
  reply: boolean
  onReply: () => void
}

export const Toolbar = forwardRef<HTMLDivElement, ToolbarProps & { style: React.CSSProperties }>(function Toolbar(p, ref) {
  const i = useI18n()
  const { t } = i
  const [picker, setPicker] = useState(false)
  const targetName = i.langLabel(p.target, LANGUAGES.find((l) => l.code === p.target)?.name)
  const busy = p.phase === 'ocr' || p.phase === 'translating'
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
        <StatusIcon phase={p.phase} paused={p.paused} />
        <button className={`tb-lang${picker ? ' is-open' : ''}`} aria-label={`${t('lp.placeholder')} ${targetName}`} aria-expanded={picker} onClick={() => setPicker((v) => !v)}>
          <span className="tb-dst">{targetName}</span>
          <ChevronDown size={13} className="tb-chev" />
        </button>
        <Tip label={t('tb.autoTranslate')} side={p.pickerUp ? 'top' : 'bottom'}>
          <label className="tb-auto">
            <input type="checkbox" aria-label={t('tb.autoTranslate')} checked={p.autoTranslate} disabled={p.autoTranslateBusy} onChange={(e) => p.onAutoTranslate(e.target.checked)} />
            <span className="tb-auto-box" aria-hidden="true"><Check size={12} strokeWidth={2.4} /></span>
          </label>
        </Tip>
        {p.phase === 'error' && p.error && <span className="tb-error" title={p.error.message}>{p.error.message}</span>}
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
        </AnimatePresence>
        {p.phase === 'error' && (p.error?.code === 'auth' || p.error?.code === 'config') && (
          <button className="tb-pill" onClick={p.onSettings}>
            <Settings2 size={13} /> {t('tb.settings')}
          </button>
        )}
        {p.phase === 'error' && !['auth', 'config', 'no-text'].includes(p.error?.code ?? '') && (
          <button className="tb-pill" onClick={p.onRetry}>
            <RotateCw size={13} /> {t('tb.retry')}
          </button>
        )}
      </div>

      <div className="tb-sep" />

      <Tip label={busy ? t('tb.busy') : t(p.recognized === 'ocr-only' ? 'tb.translate' : 'tb.retranslate')} keys={shortcutLabel('Ctrl R')}>
        <button className="tb-btn tb-translate" disabled={busy} onClick={p.onRetry} aria-label={t(p.recognized === 'ocr-only' ? 'tb.translate' : 'tb.retranslate')}>
          {p.recognized === 'ocr-only' ? <Languages size={17} /> : <RotateCw size={15} className={p.phase === 'translating' ? 'spin-slow' : ''} />}
        </button>
      </Tip>
      <Tip label={p.reply ? t('tb.replyClose') : t('tb.reply')} keys="R">
        <button className={`tb-btn tb-reply${p.reply ? ' on' : ''}`} aria-label={t('tb.reply')} aria-pressed={p.reply} onClick={p.onReply}>
          <MessageSquareReply size={16} />
        </button>
      </Tip>
      <Tip label={t('tb.side')} keys="Tab">
        <button className={`tb-btn tb-compare${p.mode === 'side' ? ' on' : ''}`} aria-label={t('tb.side')} aria-pressed={p.mode === 'side'} onClick={() => p.onMode(p.mode === 'side' ? 'overlay' : 'side')}>
          <Columns2 size={16} />
        </button>
      </Tip>

      <div className="tb-sep" />

      <Tip label={t('tb.copySource')} keys={shortcutLabel('Alt C')}>
        <button className="tb-btn" aria-label={t('tb.copySource')} disabled={!p.progress.total} onClick={p.onCopySource}>
          <ScanText size={17} />
        </button>
      </Tip>
      <Tip label={t('tb.copy')} keys={shortcutLabel('Ctrl C')}>
        <button className="tb-btn" disabled={!p.progress.done} onClick={p.onCopy}>
          <Copy size={16} />
        </button>
      </Tip>
      <Tip label={t('tb.copyImage')} keys={shortcutLabel('Ctrl Shift C')}>
        <button className="tb-btn" disabled={!p.progress.done} onClick={p.onCopyImage}>
          <ImageDown size={17} />
        </button>
      </Tip>
      <Tip label={p.paused ? t('tb.pinOriginal') : t('tb.pin')} keys={isMac ? '⌘ T' : 'F3'}>
        <button className="tb-btn" disabled={!p.progress.done && !p.paused} onClick={(e) => p.onPin(e.altKey)}>
          <Pin size={16} />
        </button>
      </Tip>
      <Tip label={t('tb.save')} keys={shortcutLabel('Ctrl S')}>
        <button className="tb-btn" disabled={!p.progress.done} onClick={p.onSave}>
          <Download size={16} />
        </button>
      </Tip>

      <div className="tb-sep" />

      <Tip label={t('tb.settingsTip')}>
        <button className="tb-btn" onClick={p.onSettings}>
          <Settings2 size={16} />
        </button>
      </Tip>
      <ShortcutHelp />
      <Tip label={t('tb.close')} keys="Esc">
        <button className="tb-btn tb-close" onClick={p.onClose}>
          <X size={17} />
        </button>
      </Tip>

      {/* 底部进度光带 */}
      <AnimatePresence>
        {p.phase === 'translating' && (
          <motion.div className="tb-progress" initial={{ opacity: 0 }} animate={{ opacity: p.paused ? 0.35 : 1 }} exit={{ opacity: 0, transition: { duration: 0.4 } }}>
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

function StatusIcon({ phase, paused }: { phase: Phase; paused: boolean }) {
  const busy = phase === 'ocr' || phase === 'translating'
  return (
    <span className="tb-icon">
      <AnimatePresence mode="wait" initial={false}>
        {phase === 'ocr' ? <ScanText size={14} aria-hidden="true" /> : busy && paused ? (
          <motion.span key="paused" className="tb-paused" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }}>
            <Pause size={10} strokeWidth={0} fill="currentColor" />
          </motion.span>
        ) : busy ? (
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
  const i = useI18n()
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const all = useMemo(() => LANGUAGES.map((l) => ({ ...l, label: i.langLabel(l.code, l.name) })), [i])
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? all.filter((l) => (l.label + l.name + l.native + l.code).toLowerCase().includes(s)) : all
  }, [q, all])
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
          placeholder={i.t('lp.placeholder')}
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
            <span className="lp-name">{l.label}</span>
            <span className="lp-native">{l.native}</span>
            {l.code === current && <Check size={13} className="lp-check" />}
          </motion.button>
        ))}
        {!list.length && <div className="lp-empty">{i.t('lp.empty')}</div>}
      </div>
    </motion.div>
  )
}
