// Native timer + message loop: releases input even when Electron's main thread stalls.
import { parentPort, workerData } from 'node:worker_threads'
import koffi from 'koffi'
import { KEY_STATE as S, live } from './win-space-state'

const state = new Int32Array(workerData)
const user = koffi.load('user32.dll')
const kernel = koffi.load('kernel32.dll')
const hookProc = koffi.proto('intptr_t __stdcall LavaKeyboardHook(int code, uintptr_t message, void *data)')
const install = user.func('void * __stdcall SetWindowsHookExW(int id, LavaKeyboardHook *callback, void *module, uint32_t thread)')
const uninstall = user.func('int __stdcall UnhookWindowsHookEx(void *hook)')
const next = user.func('intptr_t __stdcall CallNextHookEx(void *hook, int code, uintptr_t message, void *data)')
const getMessage = user.func('int __stdcall GetMessageW(void *msg, void *window, uint32_t min, uint32_t max)')
const peekMessage = user.func('int __stdcall PeekMessageW(void *msg, void *window, uint32_t min, uint32_t max, uint32_t remove)')
const setTimer = user.func('uintptr_t __stdcall SetTimer(void *window, uintptr_t id, uint32_t ms, void *callback)')
const killTimer = user.func('int __stdcall KillTimer(void *window, uintptr_t id)')
const keyState = user.func('short __stdcall GetAsyncKeyState(int key)')
const keyEvent = user.func('void __stdcall keybd_event(uint8_t key, uint8_t scan, uint32_t flags, uintptr_t extra)')
const threadId = kernel.func('uint32_t __stdcall GetCurrentThreadId()')
const moduleHandle = kernel.func('void * __stdcall GetModuleHandleW(void *name)')
const down = (key: number) => (keyState(key) & 0x8000) !== 0
let consumed: 'shortcut' | 'record' | 'scroll' | null = null
let lastSpace = 0
let reset = 0

function release() {
  consumed = null
  Atomics.store(state, S.held, 0)
}

function allowed() {
  const revision = Atomics.load(state, S.reset)
  if (revision !== reset) { release(); reset = revision }
  // Lost key-up without any following keyboard input: never leave scrolling stuck.
  if (consumed && Date.now() - lastSpace > 5000) release()
  const alive = !Atomics.load(state, S.stop) && live(Atomics.load(state, S.mainUntil))
  const mode = alive ? Atomics.load(state, S.mode) : 0
  const capture = alive && !!Atomics.load(state, S.capture) && live(Atomics.load(state, S.captureUntil))
  if ((!alive || !capture) && Atomics.exchange(state, S.capture, 0)) parentPort!.postMessage('expired')
  if (!alive || (consumed === 'scroll' && !capture) || (consumed === 'shortcut' && mode !== 1) || (consumed === 'record' && mode !== 2)) release()
  return { mode, capture }
}

function holdForScroll(capture: boolean) {
  consumed = 'scroll'
  Atomics.store(state, S.held, 1)
  if (capture) parentPort!.postMessage('scroll')
}

const callback = koffi.register((code: number, message: number, data: unknown) => {
  if (code < 0) return next(null, code, message, data)
  const { mode, capture } = allowed()
  if (!mode && !capture) return next(null, code, message, data)
  const key = koffi.decode(data, 'uint32_t')
  const up = message === 0x0101 || message === 0x0105
  if (up && consumed === 'shortcut' && (key === 0x5b || key === 0x5c) && !down(key === 0x5b ? 0x5c : 0x5b) && capture) holdForScroll(capture)
  if (key === 0x20) {
    // Held keys repeat; a long gap means a missed release, not an endless hold.
    if (consumed && !up && Date.now() - lastSpace > 1200) release()
    lastSpace = Date.now()
    if (consumed) {
      if (up) release()
      return 1
    }
    if (!up && !down(0x10) && !down(0x11) && !down(0x12)) {
      const win = down(0x5b) || down(0x5c)
      if (!win && capture) {
        holdForScroll(capture)
        return 1
      }
      if (!win || !mode) return next(null, code, message, data)
      consumed = mode === 2 ? 'record' : 'shortcut'
      // Unassigned VK_E8 masks the Start menu without injecting Ctrl into an IME.
      keyEvent(0xe8, 0, 0, 0)
      keyEvent(0xe8, 0, 2, 0)
      parentPort!.postMessage(mode === 2 ? 'record' : 'press')
      return 1
    }
  }
  return next(null, code, message, data)
}, koffi.pointer(hookProc))

let hook: unknown = null
let timer = 0
let acknowledged = -1
function synchronize() {
  const { mode, capture } = allowed()
  const revision = Atomics.load(state, S.revision)
  if (!mode && !capture && hook) {
    uninstall(hook)
    hook = null
    release()
  } else if ((mode || capture) && !hook) {
    hook = install(13, callback, moduleHandle(null), 0)
  }
  if (revision !== acknowledged) {
    acknowledged = revision
    parentPort!.postMessage({ revision, ok: (!mode && !capture) || !!hook })
  }
}

try {
  const message = Buffer.alloc(48)
  peekMessage(message, null, 0, 0, 0)
  Atomics.store(state, S.thread, threadId())
  timer = setTimer(null, 0, 100, null)
  if (!timer) throw new Error('Keyboard watchdog timer unavailable')
  synchronize()
  parentPort!.postMessage('ready')
  while (!Atomics.load(state, S.stop) && getMessage(message, null, 0, 0) > 0) synchronize()
} finally {
  if (hook) uninstall(hook)
  if (timer) killTimer(null, timer)
  release()
  koffi.unregister(callback)
  parentPort!.close()
}
