import { CircleHelp } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { isMac, shortcutLabel } from '../lib/desktop'
import { useI18n } from '../lib/i18n'

/** 悬停打开快捷操作；浮层贴合可用屏幕空间，鼠标移入后可以滚动。 */
export function ShortcutHelp() {
  const { t } = useI18n()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const show = () => { clear(); timer.current = setTimeout(() => setOpen(true), 300) }
  const hide = () => { clear(); timer.current = setTimeout(() => setOpen(false), 140) }

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!anchor.current || !panel.current) return
      const a = anchor.current.getBoundingClientRect()
      const width = panel.current.offsetWidth
      const height = panel.current.scrollHeight + 2
      const above = Math.max(0, a.top - 18)
      const below = Math.max(0, window.innerHeight - a.bottom - 18)
      const up = above >= height || above > below
      const maxHeight = up ? above : below
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - width - 8, a.right - width)),
        top: up ? a.top - 10 - Math.min(height, maxHeight) : a.bottom + 10,
        maxHeight
      })
    }
    place()
    window.addEventListener('resize', place)
    const observer = new ResizeObserver(place)
    if (anchor.current?.closest('.toolbar')) observer.observe(anchor.current.closest('.toolbar')!)
    const dismiss = () => { clear(); setOpen(false) }
    window.addEventListener('blur', dismiss)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('blur', dismiss) }
  }, [open])

  const rows = [
    [shortcutLabel('Ctrl R') + ' / F5', `${t('tb.translate')} / ${t('tb.retranslate')}`],
    ['R', t('sc.replyDo')],
    ['Tab', t('sc.tabDo')],
    [t('sc.alt'), t('sc.altDo')],
    [t('sc.space'), t('sc.spaceDo')],
    [shortcutLabel('Ctrl C'), t('sc.copyAll')],
    [shortcutLabel('Alt C'), t('tb.copySource')],
    [shortcutLabel('Ctrl Shift C'), t('sc.copyImage')],
    [shortcutLabel('Ctrl S'), t('tb.save')],
    [isMac ? '⌘ T' : 'F3', t('tb.pin')],
    [isMac ? '⌥ ⌘ T' : 'Alt F3', t('tb.pinOriginal')],
    ['Enter', t('sc.enterDo')],
    [t('sc.clickText'), t('sc.clickTextDo')],
    [t('sc.dbl'), t('sc.dblDo')],
    [t('sc.altDbl'), t('sc.altDblDo')],
    [t('sc.exit'), t('sc.exitDo')]
  ]

  return (
    <span ref={anchor} className="tb-help-anchor" onMouseEnter={show} onMouseLeave={hide}>
      <button
        type="button" className="tb-btn tb-help" aria-label={t('home.keys')} aria-expanded={open} aria-describedby={open ? id : undefined}
        onFocus={() => { clear(); setOpen(true) }} onBlur={hide}
        onClick={() => { clear(); setOpen(true) }}
      >
        <CircleHelp size={16} />
      </button>
      {open && createPortal(
        <div
          ref={panel} id={id} role="tooltip" className="tb-shortcuts" style={position} tabIndex={0}
          onMouseEnter={clear} onMouseLeave={hide} onFocus={clear} onBlur={hide}
          onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation() }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div className="tb-shortcuts-title">{t('home.keys')}</div>
          {rows.map(([key, action]) => <div className="tb-shortcut" key={key}><span>{action}</span><kbd>{key}</kbd></div>)}
        </div>, anchor.current?.closest('.overlay') ?? document.body
      )}
    </span>
  )
}
