// 网页 ↔ 安卓原生的通道（见 android/.../web/Bridge.kt）。
// call：请求并等回复；notify：只发不等；on：订阅原生推送的事件。
// 另外把模型请求交给原生 OkHttp 代发（nativeFetch），绕开 WebView 的跨域限制，并保持流式输出
import { setPlatform } from '@core/platform'

interface NativePort {
  postMessage(data: string): void
  onmessage: ((e: MessageEvent<string>) => void) | null
}

declare global {
  interface Window {
    /** 原生 WebMessageListener 注入的对象 */
    lava?: NativePort
  }
}

type Msg = { id?: number; ok?: boolean; r?: unknown; e?: string; ev?: string; d?: unknown }

let seq = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
const listeners = new Map<string, Set<(d: any) => void>>()

function port(): NativePort {
  if (!window.lava) throw new Error('不在 LavaTranslate 应用里')
  return window.lava
}

if (window.lava) {
  window.lava.onmessage = (e) => {
    let msg: Msg
    try {
      msg = JSON.parse(e.data)
    } catch {
      return
    }
    if (msg.id) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.r)
      else p.reject(new Error(msg.e ?? '操作失败'))
    } else if (msg.ev) listeners.get(msg.ev)?.forEach((cb) => cb(msg.d))
  }
}

export function call<T = any>(m: string, a?: object): Promise<T> {
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      port().postMessage(JSON.stringify({ id, m, a: a ?? {} }))
    } catch (e) {
      pending.delete(id)
      reject(e as Error)
    }
  })
}

export function notify(m: string, a?: object) {
  window.lava?.postMessage(JSON.stringify({ m, a: a ?? {} }))
}

export function on<T = any>(ev: string, cb: (d: T) => void) {
  let set = listeners.get(ev)
  if (!set) listeners.set(ev, (set = new Set()))
  set.add(cb)
  return () => {
    set!.delete(cb)
  }
}

// ------------------------------------------------------------------ fetch 代发
type NetEvent =
  | { rid: string; t: 'head'; status: number; statusText: string; headers: Record<string, string> }
  | { rid: string; t: 'data'; s: string }
  | { rid: string; t: 'end' }
  | { rid: string; t: 'err'; msg: string }

const streams = new Map<string, (e: NetEvent) => void>()
on<NetEvent>('net', (e) => streams.get(e.rid)?.(e))

const NULL_BODY = new Set([101, 204, 205, 304])

export const nativeFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init)
  const body = init?.body == null ? null : await req.text()
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => (headers[k] = v))
  const signal = init?.signal ?? null
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  const rid = `r${++seq}`

  return new Promise<Response>((resolve, reject) => {
    const enc = new TextEncoder()
    let ctl!: ReadableStreamDefaultController<Uint8Array>
    let settled = false
    let finished = false
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c
      },
      cancel() {
        done()
        notify('net.abort', { rid })
      }
    })
    const done = () => {
      finished = true
      streams.delete(rid)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (err: Error) => {
      done()
      if (!settled) {
        settled = true
        reject(err)
      }
      try {
        ctl.error(err)
      } catch {
        /* 已关闭 */
      }
    }
    const onAbort = () => {
      notify('net.abort', { rid })
      fail(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort)

    streams.set(rid, (e) => {
      if (finished) return
      if (e.t === 'head') {
        settled = true
        resolve(new Response(NULL_BODY.has(e.status) ? null : stream, { status: e.status, statusText: e.statusText, headers: e.headers }))
      } else if (e.t === 'data') ctl.enqueue(enc.encode(e.s))
      else if (e.t === 'end') {
        done()
        try {
          ctl.close()
        } catch {
          /* 已关闭 */
        }
      } else fail(new TypeError(e.msg || '网络错误'))
    })
    notify('net.req', { rid, url: req.url, method: req.method, headers, body })
  })
}

// 老版本系统 WebView 没有 AbortSignal.timeout（识别 Key 时用到）
if (typeof AbortSignal !== 'undefined' && !('timeout' in AbortSignal)) {
  ;(AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number) => {
    const c = new AbortController()
    setTimeout(() => c.abort(new DOMException('TimeoutError', 'TimeoutError')), ms)
    return c.signal
  }
}

setPlatform({
  fetch: nativeFetch,
  preconnect: (url) => notify('preconnect', { url })
})
