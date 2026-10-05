// 回复助手的宿主：桌面版 ReplyComposer 通过 window.lens 调主进程，这里在网页内直接调引擎，接口保持一致
import { langFor } from '@core/lang'
import type { ReplyEvent, ReplyStartMsg } from '@shared/types'
import { notify } from '../bridge'
import { engineFor, engineProblem, type MobileSettings } from '../engine'

type Listener = (d: { requestId: number; event: ReplyEvent }) => void

export function installReplyHost(getSettings: () => MobileSettings | null) {
  const listeners = new Set<Listener>()
  let ctl: AbortController | null = null
  const send = (requestId: number, event: ReplyEvent) => listeners.forEach((l) => l({ requestId, event }))

  const lens = {
    replyStart(msg: ReplyStartMsg) {
      ctl?.abort()
      const c = (ctl = new AbortController())
      const s = getSettings()
      const eng = s && engineFor(s)
      if (!s || !eng) return send(msg.requestId, { type: 'error', message: (s && engineProblem(s)) ?? '翻译服务还没有配置' })
      const t0 = Date.now()
      eng
        .reply(
          { text: msg.text, from: langFor(s.targetLang), to: langFor(msg.to, msg.toName), context: msg.context, tone: msg.tone, quick: msg.quick },
          (d) => send(msg.requestId, { type: 'delta', text: d }),
          c.signal
        )
        .then(() => {
          if (!c.signal.aborted) send(msg.requestId, { type: 'done', ms: Date.now() - t0 })
        })
        .catch((e: unknown) => {
          if (!c.signal.aborted) send(msg.requestId, { type: 'error', message: e instanceof Error ? e.message : String(e) })
        })
    },
    replyCancel() {
      ctl?.abort()
      ctl = null
    },
    onReply(cb: Listener) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    copyText(text: string) {
      notify('copy', { text })
    }
  }
  ;(window as unknown as { lens: typeof lens }).lens = lens
}
