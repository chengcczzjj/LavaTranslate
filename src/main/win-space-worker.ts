// Keep the hook on its own message-loop thread: OCR / main-process work must never block keyboard input.
import { parentPort, workerData } from 'node:worker_threads'
import koffi from 'koffi'

const state = new Int32Array(workerData)
const user = koffi.load('user32.dll')
const kernel = koffi.load('kernel32.dll')
const hookProc = koffi.proto('intptr_t __stdcall LavaKeyboardHook(int code, uintptr_t message, void *data)')
const install = user.func('void * __stdcall SetWindowsHookExW(int id, LavaKeyboardHook *callback, void *module, uint32_t thread)')
const uninstall = user.func('int __stdcall UnhookWindowsHookEx(void *hook)')
const next = user.func('intptr_t __stdcall CallNextHookEx(void *hook, int code, uintptr_t message, void *data)')
const getMessage = user.func('int __stdcall GetMessageW(void *msg, void *window, uint32_t min, uint32_t max)')
const peekMessage = user.func('int __stdcall PeekMessageW(void *msg, void *window, uint32_t min, uint32_t max, uint32_t remove)')
const keyState = user.func('short __stdcall GetAsyncKeyState(int key)')
const keyEvent = user.func('void __stdcall keybd_event(uint8_t key, uint8_t scan, uint32_t flags, uintptr_t extra)')
const threadId = kernel.func('uint32_t __stdcall GetCurrentThreadId()')
const moduleHandle = kernel.func('void * __stdcall GetModuleHandleW(void *name)')
const down = (key: number) => (keyState(key) & 0x8000) !== 0
let consumed = false

const callback = koffi.register((code: number, message: number, data: unknown) => {
  if (code >= 0 && koffi.decode(data, 'uint32_t') === 0x20) {
    const up = message === 0x0101 || message === 0x0105
    if (consumed) {
      if (up) consumed = false
      return 1 // Suppress auto-repeat and the paired keyup, even if Win was released first.
    }
    const mode = Atomics.load(state, 0)
    if (!up && mode && (down(0x5b) || down(0x5c)) && !down(0x10) && !down(0x11) && !down(0x12)) {
      consumed = true
      // Mark Win as used so releasing it does not open Start. Ctrl has no action on its own.
      keyEvent(0x11, 0, 0, 0)
      keyEvent(0x11, 0, 2, 0)
      parentPort!.postMessage(mode === 2 ? 'record' : 'press')
      return 1
    }
  }
  return next(null, code, message, data)
}, koffi.pointer(hookProc))

let hook: unknown = null
try {
  const message = Buffer.alloc(48) // MSG on Windows x64
  peekMessage(message, null, 0, 0, 0) // Create the queue before publishing its thread ID.
  Atomics.store(state, 1, threadId())
  if (!Atomics.load(state, 2)) {
    hook = install(13, callback, moduleHandle(null), 0)
    if (!hook) throw new Error('SetWindowsHookExW failed')
    parentPort!.postMessage('ready')
    while (!Atomics.load(state, 2) && getMessage(message, null, 0, 0) > 0) { /* hook runs inside GetMessage */ }
  }
} finally {
  if (hook) uninstall(hook)
  koffi.unregister(callback)
  parentPort!.close()
}
