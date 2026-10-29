import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { load } from 'koffi'

/** Win+Space is reserved by Windows, so Electron's RegisterHotKey cannot claim it. */
export class WinSpaceHotkey {
  private worker: Worker | null = null
  private state = new Int32Array(new SharedArrayBuffer(12)) // mode, native thread ID, stop
  private ready = false

  async start(onPress: (recording: boolean) => void): Promise<boolean> {
    if (process.platform !== 'win32') return false
    try {
      const worker = new Worker(join(__dirname, 'win-space-worker.js'), { workerData: this.state.buffer })
      this.worker = worker
      worker.unref()
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { this.stop(); resolve(false) }, 5000)
        worker.on('message', (message: 'ready' | 'press' | 'record') => {
          if (message === 'ready') {
            clearTimeout(timer)
            if (Atomics.load(this.state, 2)) return
            this.ready = true
            resolve(true)
          } else if (this.ready) {
            const mode = Atomics.load(this.state, 0)
            if ((message === 'press' && mode === 1) || (message === 'record' && mode === 2)) onPress(message === 'record')
          }
        })
        worker.on('error', (error) => { console.error('Win+Space hook unavailable', error) })
        worker.on('exit', () => {
          clearTimeout(timer)
          this.ready = false
          this.worker = null
          resolve(false)
        })
      })
    } catch (error) {
      console.error('Win+Space hook unavailable', error)
      return false
    }
  }

  /** Recording still consumes the reserved shortcut, and forwards it to Settings. */
  setMode(mode: 0 | 1 | 2): boolean {
    Atomics.store(this.state, 0, mode)
    return this.ready
  }

  stop() {
    this.setMode(0)
    this.ready = false
    Atomics.store(this.state, 2, 1)
    const thread = Atomics.load(this.state, 1)
    if (!thread || !this.worker) return
    try {
      load('user32.dll').func('int __stdcall PostThreadMessageW(uint32_t id, uint32_t msg, uintptr_t w, intptr_t l)')(thread, 0x0012, 0, 0)
    } catch (error) { console.error('Win+Space hook shutdown', error) }
  }
}
