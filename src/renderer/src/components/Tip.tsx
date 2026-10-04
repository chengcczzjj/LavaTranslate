import { AnimatePresence, motion } from 'motion/react'
import { useRef, useState, type ReactNode } from 'react'

/** 悬停延迟出现的提示气泡，带快捷键 */
export function Tip({ label, keys, children, side = 'top' }: { label: string; keys?: string; children: ReactNode; side?: 'top' | 'bottom' }) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number>(0)
  return (
    <span
      className="tip-anchor"
      onMouseEnter={() => {
        timer.current = window.setTimeout(() => setOpen(true), 380)
      }}
      onMouseLeave={() => {
        clearTimeout(timer.current)
        setOpen(false)
      }}
      onMouseDown={() => {
        clearTimeout(timer.current)
        setOpen(false)
      }}
    >
      {children}
      <span className={`tip-pos ${side}`}>
        <AnimatePresence>
          {open && (
            <motion.span
              className="tip"
              initial={{ opacity: 0, y: side === 'top' ? 4 : -4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              {label}
              {keys && <kbd>{keys}</kbd>}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </span>
  )
}
