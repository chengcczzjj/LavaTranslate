import { AnimatePresence, motion } from 'motion/react'
import { memo, useMemo, useRef } from 'react'
import type { BlockColors, OcrLine, TranslatedBlock } from '@shared/types'
import { layoutBlocks } from '../lib/layout'
import './translation-layer.css'

export interface LayerProps {
  lines: OcrLine[]
  blocks: TranslatedBlock[]
  /** 按 OCR 行 id 的视觉样式 */
  colors: Record<number, BlockColors>
  /** 物理像素 / CSS 像素 */
  scale: number
  width: number
  height: number
  targetLang: string
  /** 显示原文（隐藏译文） */
  peek: boolean
  /** 正在等待译文的行 —— 显示扫描骨架 */
  pending: Set<number> | null
  hoverKey?: string | null
  onHover?: (key: string | null) => void
}

const EASE = [0.22, 1, 0.36, 1] as const
/** 原文 / 译文切换时，从上到下依次过渡：最上面一段和最下面一段相差这么多秒 */
const SWEEP = 0.12
/** 切换后这段时间（毫秒）里都按位置错开，期间新到的段落（暂停后补上的）也跟着一起扫过去 */
const SWEEP_WINDOW = 700
export const TranslationLayer = memo(function TranslationLayer(p: LayerProps) {
  const layouts = useMemo(
    () => layoutBlocks(p.blocks, p.lines, p.colors, p.scale, p.width, p.height, p.targetLang),
    [p.blocks, p.lines, p.colors, p.scale, p.width, p.height, p.targetLang]
  )
  // 记下切换原文 / 译文的时刻（渲染时就要知道，动画才能带上错开的延迟）
  const flip = useRef({ peek: p.peek, at: 0 })
  if (flip.current.peek !== p.peek) flip.current = { peek: p.peek, at: performance.now() }
  const sweeping = performance.now() - flip.current.at < SWEEP_WINDOW
  const delayOf = (y: number) => (sweeping ? Math.max(0, Math.min(1, y / Math.max(1, p.height))) * SWEEP : 0)
  // 隐藏：译文先模糊淡出，补丁随后褪去露出原文；显示：补丁先盖回去，译文再从模糊变清晰
  const patchMotion = (d: number) => ({
    initial: { opacity: 0 },
    animate: { opacity: p.peek ? 0 : 1 },
    transition: p.peek ? { duration: 0.22, delay: d + 0.05, ease: EASE } : { duration: 0.24, delay: d, ease: EASE }
  })
  const textMotion = (d: number) => ({
    initial: { opacity: 0, filter: 'blur(6px)' },
    animate: { opacity: p.peek ? 0 : 1, filter: p.peek ? 'blur(4px)' : 'blur(0px)' },
    transition: p.peek ? { duration: 0.2, delay: d, ease: EASE } : { duration: 0.3, delay: d + 0.06, ease: EASE }
  })

  return (
    <div className="tl-layer" style={{ width: p.width, height: p.height }}>
      <AnimatePresence>
        {p.pending &&
          p.lines
            .filter((l) => p.pending!.has(l.id))
            .map((l, i) => (
              <motion.div
                key={`s${l.id}`}
                className="tl-skel"
                style={{ left: l.box.x / p.scale, top: l.box.y / p.scale, width: l.box.w / p.scale, height: l.box.h / p.scale }}
                initial={{ opacity: 0, scaleX: 0.6 }}
                animate={{ opacity: 1, scaleX: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.25 } }}
                transition={{ delay: Math.min(i * 0.018, 0.3), duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              />
            ))}
      </AnimatePresence>

      {/* 先画所有补丁，再画所有文字：相邻块的补丁不会盖住别的块的文字 */}
      {layouts.map((L) => (
        <motion.div key={`pg${L.key}`} className="tl-pgroup" {...patchMotion(delayOf(L.box.y))}>
          {L.patches.map((q, i) => (
            <div
              key={i}
              className="tl-patch"
              style={{ left: q.x, top: q.y, width: q.w, height: q.h, background: q.bg }}
            />
          ))}
        </motion.div>
      ))}

      {layouts.map((L) => (
        <motion.div
          key={`tg${L.key}`}
          className={`tl-block${p.hoverKey === L.key ? ' is-hover' : ''}`}
          data-block={L.key}
          title={L.truncated ? L.fullText : undefined}
          onMouseEnter={() => p.onHover?.(L.key)}
          onMouseLeave={() => p.onHover?.(null)}
          style={{ left: L.box.x, top: L.box.y, width: L.box.w, height: L.box.h, color: L.fg, fontFamily: L.family, fontWeight: L.weight, fontSize: L.fontSize }}
          {...textMotion(delayOf(L.box.y))}
        >
          {L.pieces.map((q, i) =>
            q.text ? (
              <div
                key={i}
                className="tl-line"
                style={{
                  left: q.x - L.box.x,
                  top: q.y - L.box.y,
                  width: q.w,
                  height: q.h,
                  lineHeight: `${q.h}px`,
                  justifyContent: L.align === 'center' ? 'center' : L.align === 'right' ? 'flex-end' : 'flex-start',
                  textAlign: L.align,
                  whiteSpace: 'pre',
                  writingMode: q.vertical ? 'vertical-rl' : undefined
                }}
              >
                {q.text}
              </div>
            ) : null
          )}
        </motion.div>
      ))}
    </div>
  )
})
