import { app, dialog } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { release } from 'node:os'

export function logError(kind: string, error: unknown): string | null {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error)
  const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`
  console.error(line)
  // userData 不可写时仍尽量留下日志；首次启动目录可能还不存在。
  for (const [location, filename] of [['userData', 'error.log'], ['temp', 'LavaTranslate-error.log']] as const) {
    try {
      const file = join(app.getPath(location), filename)
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, line)
      return file
    } catch { /* 尝试下一个位置 */ }
  }
  return null
}

export function startupFailed(error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error)
  const log = logError('startup', `LavaTranslate ${app.getVersion()}; ${process.platform} ${release()} ${process.arch}; Electron ${process.versions.electron}\n${detail}`)
  const zh = /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale)
  const nativeFailure = /ERR_DLOPEN_FAILED|DLL|native binding|onnxruntime|koffi|node-screenshots/i.test(detail)
  const help = process.platform === 'win32' && nativeFailure
    ? (zh ? '\n也可尝试安装或修复微软 VC++ x64 运行库：\n' : '\nYou can also install or repair the Microsoft VC++ x64 runtime:\n') + 'https://aka.ms/vc14/vc_redist.x64.exe\n'
    : ''
  const message = zh
    ? `启动失败，请重新安装最新版本。如果仍失败，请将此窗口和日志发给开发者。\n${help}\n日志：${log ?? '无法写入日志'}\n\n${detail}`
    : `Startup failed. Reinstall the latest version. If it still fails, send this message and the log to the developer.\n${help}\nLog: ${log ?? 'Unable to write a log'}\n\n${detail}`
  try {
    // showErrorBox 在 app ready 之前也能显示，适用于 DLL 导入失败。
    dialog.showErrorBox(zh ? 'LavaTranslate 无法启动' : 'LavaTranslate could not start', message)
  } finally {
    app.exit(1)
  }
}
