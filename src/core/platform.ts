// 宿主注入的平台能力。core 里的代码桌面（Electron 主进程）和安卓（WebView）共用：
// 桌面用 Electron net（Chromium 网络栈、系统代理、HTTP/2），安卓用原生 OkHttp 转发（绕开 WebView 的跨域限制）

export interface Platform {
  fetch: typeof fetch
  /** 提前建立到接口地址的连接（截图界面一打开就调用） */
  preconnect?: (url: string) => void
}

let platform: Platform = { fetch: (input, init) => globalThis.fetch(input, init) }

export function setPlatform(p: Platform) {
  platform = p
}

export const pfetch: typeof fetch = (input, init) => platform.fetch(input, init)

export function preconnect(url: string) {
  try {
    platform.preconnect?.(url)
  } catch {
    /* 忽略 */
  }
}

/** 自测开关：只有桌面主进程有 process.env */
export function env(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
}
