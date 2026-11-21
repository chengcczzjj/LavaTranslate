import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { load } from 'koffi'
import { CAPTURE_LEASE_MS, deadline, HOOK_WAKE, KEY_STATE as S, KEY_STATE_SIZE, MAIN_LEASE_MS } from './win-space-state'

/** The worker stays idle without a hook unless Win+Space or capture needs it. */
export class WinSpaceHotkey {
  private worker: Worker | null = null
  private state = new Int32Array(new SharedArrayBuffer(KEY_STATE_SIZE * 4))
  private ready = false
  private stopped = false
  private starting: Promise<boolean> | null = null
  private callbacks: { onPress: (recording: boolean) => void; onScroll?: () => void; onExpired?: () => void } | null = null
  private heartbeat: NodeJS.Timeout | null = null
  private pending = new Map<number, (ok: boolean) => void>()
  private post: ((id: number, msg: number, w: number, l: number) => number) | null = null

  async start(onPress: (recording: boolean) => void, onScroll?: () => void, onExpired?: () => void): Promise<boolean> {
    if (process.platform !== 'win32') return false
    this.stopped = false
    this.callbacks = { onPress, onScroll, onExpired }
    if (this.worker) return this.ready
    if (this.starting) return this.starting
    this.starting = this.spawn(onPress, onScroll, onExpired).finally(() => { this.starting = null })
    return this.starting
  }

  private async spawn(onPress: (recording: boolean) => void, onScroll?: () => void, onExpired?: () => void): Promise<boolean> {
    this.state = new Int32Array(new SharedArrayBuffer(KEY_STATE_SIZE * 4))
    try {
      this.post = load('user32.dll').func('int __stdcall PostThreadMessageW(uint32_t id, uint32_t msg, uintptr_t w, intptr_t l)')
      const worker = new Worker(join(__dirname, 'win-space-worker.js'), { workerData: this.state.buffer })
      this.worker = worker
      worker.unref()
      this.beat()
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { this.shutdown(false); resolve(false) }, 5000)
        worker.on('message', (message: 'ready' | 'press' | 'record' | 'scroll' | 'expired' | { revision: number; ok: boolean }) => {
          if (this.worker !== worker) return
          if (message === 'ready') {
            clearTimeout(timer)
            if (Atomics.load(this.state, S.stop)) return
            this.ready = true
            this.beat()
            this.heartbeat = setInterval(() => this.beat(), 250)
            this.heartbeat.unref()
            resolve(true)
          } else if (typeof message === 'object') {
            for (const [revision, done] of this.pending) if (revision <= message.revision) {
              this.pending.delete(revision)
              done(message.ok)
            }
          } else if (this.ready && message === 'expired') onExpired?.()
          else if (this.ready && message === 'scroll') {
            if (Atomics.load(this.state, S.capture)) onScroll?.()
          } else if (this.ready) {
            const mode = Atomics.load(this.state, S.mode)
            if ((message === 'press' && mode === 1) || (message === 'record' && mode === 2)) onPress(message === 'record')
          }
        })
        worker.on('error', (error) => console.error('Win+Space hook unavailable', error))
        worker.on('exit', () => {
          clearTimeout(timer)
          if (this.worker === worker) {
            this.clear()
            this.worker = null
            onExpired?.()
          }
          resolve(false)
        })
      })
    } catch (error) {
      console.error('Win+Space hook unavailable', error)
      this.shutdown(false)
      return false
    }
  }

  private async ensureStarted(): Promise<boolean> {
    if (process.platform !== 'win32' || this.stopped) return false
    if (this.ready && this.worker) return true
    if (this.starting) return this.starting
    if (!this.callbacks) return false
    return this.start(this.callbacks.onPress, this.callbacks.onScroll, this.callbacks.onExpired)
  }

  private beat() { Atomics.store(this.state, S.mainUntil, deadline(MAIN_LEASE_MS)) }

  private wake(message = HOOK_WAKE) {
    const thread = Atomics.load(this.state, S.thread)
    if (thread) this.post?.(thread, message, 0, 0)
  }

  private apply(): Promise<boolean> {
    if (!this.ready) return Promise.resolve(false)
    const revision = Atomics.add(this.state, S.revision, 1) + 1
    this.beat()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(revision)
        Atomics.store(this.state, S.capture, 0)
        Atomics.store(this.state, S.held, 0)
        resolve(false)
      }, 2000)
      timer.unref()
      this.pending.set(revision, (ok) => { clearTimeout(timer); resolve(ok) })
      this.wake()
    })
  }

  async setMode(mode: 0 | 1 | 2): Promise<boolean> {
    if (mode !== 0 && !this.ready && !(await this.ensureStarted())) return false
    Atomics.store(this.state, S.mode, mode)
    if (!mode) Atomics.add(this.state, S.reset, 1)
    return this.apply()
  }

  /** Only a live renderer renews this lease; the main heartbeat cannot extend it. */
  async setCaptureSpace(enabled: boolean, lease = CAPTURE_LEASE_MS): Promise<boolean> {
    if (enabled && !this.ready && !(await this.ensureStarted())) return false
    Atomics.store(this.state, S.captureUntil, enabled ? deadline(lease) : 0)
    const previous = Atomics.exchange(this.state, S.capture, Number(enabled))
    if (!enabled) {
      Atomics.store(this.state, S.held, 0)
      Atomics.add(this.state, S.reset, 1)
    }
    if (previous === Number(enabled)) return this.ready
    return this.apply()
  }

  get scrollHeld(): boolean { return this.ready && Atomics.load(this.state, S.held) === 1 }

  private clear() {
    this.ready = false
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const done of this.pending.values()) done(false)
    this.pending.clear()
  }

  private shutdown(permanent: boolean) {
    if (permanent) this.stopped = true
    Atomics.store(this.state, S.mode, 0)
    Atomics.store(this.state, S.capture, 0)
    Atomics.store(this.state, S.held, 0)
    Atomics.store(this.state, S.mainUntil, 0)
    Atomics.store(this.state, S.stop, 1)
    this.clear()
    this.worker = null
    try { this.wake(0x0012) } catch (error) { console.error('Win+Space hook shutdown', error) }
  }

  stop() {
    this.shutdown(true)
  }
}
