// 少量 Win32 调用（koffi）。按住 Alt 穿透遮罩时用户可能点进了别的软件，
// 遮罩收不到 keyup，只能读全局按键状态；回来时也要绕过系统的前台锁把焦点抢回来。
import { load } from 'koffi'

interface User32 {
  GetAsyncKeyState: (vk: number) => number
  GetForegroundWindow: () => number
  GetWindowThreadProcessId: (hwnd: number, pid: null) => number
  AttachThreadInput: (from: number, to: number, attach: number) => number
  SetForegroundWindow: (hwnd: number) => number
  GetCurrentThreadId: () => number
}

let api: User32 | null | undefined

function win32(): User32 | null {
  if (api !== undefined) return api
  try {
    const u = load('user32.dll')
    const k = load('kernel32.dll')
    api = {
      GetAsyncKeyState: u.func('short __stdcall GetAsyncKeyState(int vKey)'),
      GetForegroundWindow: u.func('intptr_t __stdcall GetForegroundWindow()'),
      GetWindowThreadProcessId: u.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, void *lpdwProcessId)'),
      AttachThreadInput: u.func('int __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, int fAttach)'),
      SetForegroundWindow: u.func('int __stdcall SetForegroundWindow(intptr_t hWnd)'),
      GetCurrentThreadId: k.func('uint32_t __stdcall GetCurrentThreadId()')
    }
  } catch (e) {
    console.error('win32 api unavailable', e)
    api = null
  }
  return api
}

const VK_MENU = 0x12

/** Alt 是否按着；读不到按键状态时返回 null */
export function altDown(): boolean | null {
  const u = win32()
  return u ? (u.GetAsyncKeyState(VK_MENU) & 0x8000) !== 0 : null
}

/** BrowserWindow.getNativeWindowHandle() → HWND（窗口句柄只用低 32 位） */
export function hwndOf(handle: Buffer): number {
  return handle.readUInt32LE(0)
}

/**
 * 把窗口切到前台。用户刚在别的软件里点过时，这个进程没有收到最近的输入，
 * SetForegroundWindow 会被前台锁拦下；临时挂到前台线程的输入队列上就能切过来。
 */
export function forceForeground(hwnd: number) {
  const u = win32()
  if (!u) return
  const me = u.GetCurrentThreadId()
  const fg = u.GetForegroundWindow()
  const other = fg ? u.GetWindowThreadProcessId(fg, null) : 0
  const attached = other && other !== me ? u.AttachThreadInput(me, other, 1) : 0
  try {
    u.SetForegroundWindow(hwnd)
  } finally {
    if (attached) u.AttachThreadInput(me, other, 0)
  }
}
