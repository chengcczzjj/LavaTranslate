// macOS 系统权限与全局空格状态；只在 Mac 上加载系统框架。
import { app, dialog, shell, systemPreferences, type BrowserWindow } from 'electron'
import { load } from 'koffi'
import { uiLang } from './i18n'

export const isMac = process.platform === 'darwin'

const SETTINGS_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  input: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  login: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
  keyboard: 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension'
} as const

export async function openMacSettings(pane: string): Promise<void> {
  if (!isMac || !Object.hasOwn(SETTINGS_PANES, pane)) return
  await shell.openExternal(SETTINGS_PANES[pane as keyof typeof SETTINGS_PANES])
}

export function macSettingsStatus() {
  if (!isMac) return null
  return {
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    input: api()?.canListen() ?? false,
    launchAtLogin: app.getLoginItemSettings().openAtLogin
  }
}

interface Quartz {
  requestCapture: () => boolean
  canListen: () => boolean
  requestListen: () => boolean
  keyState: (source: number, key: number) => boolean
}

let quartz: Quartz | null | undefined
function api(): Quartz | null {
  if (!isMac) return null
  if (quartz !== undefined) return quartz
  try {
    const cg = load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
    quartz = {
      requestCapture: cg.func('bool CGRequestScreenCaptureAccess()'),
      canListen: cg.func('bool CGPreflightListenEventAccess()'),
      requestListen: cg.func('bool CGRequestListenEventAccess()'),
      keyState: cg.func('bool CGEventSourceKeyState(int stateID, uint16_t key)')
    }
  } catch (e) {
    console.error('macOS CoreGraphics unavailable', e)
    quartz = null
  }
  return quartz
}

const chinese = () => uiLang().startsWith('zh')
let permissionDialog: Promise<void> | null = null

function explainPermission(kind: 'ScreenCapture' | 'ListenEvent') {
  if (permissionDialog) return permissionDialog
  permissionDialog = (async () => {
    const zh = chinese()
    const screen = kind === 'ScreenCapture'
    const permission = screen ? (zh ? '录屏与系统录音' : 'Screen & System Audio Recording') : (zh ? '输入监控' : 'Input Monitoring')
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'LavaTranslate',
      message: zh ? `请允许${permission}` : `Allow ${permission}`,
      detail: zh
        ? `${screen ? '截屏翻译需要读取屏幕画面。' : '按住空格操作其他应用、松开后恢复翻译，需要读取全局空格状态；不记录输入内容。'}在「系统设置 → 隐私与安全 → ${permission}」中允许 ${app.isPackaged ? 'LavaTranslate' : 'Electron（开发模式）'}，然后完全退出并重新打开应用。`
        : `${screen ? 'Screenshot translation needs access to your screen.' : 'Holding Space to interact with another app requires reading the global Space key state. Typed text is not recorded.'} Allow ${app.isPackaged ? 'LavaTranslate' : 'Electron (development mode)'} in System Settings → Privacy & Security → ${permission}, then quit and reopen the app.`,
      buttons: zh ? ['打开系统设置', '稍后'] : ['Open System Settings', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (response === 0) await openMacSettings(screen ? 'screen' : 'input')
  })().finally(() => { permissionDialog = null })
  return permissionDialog
}

/** 在创建截图前检查，拒绝时不能继续抓到只有桌面背景的假截图。 */
export async function ensureScreenCapture(): Promise<boolean> {
  if (!isMac || systemPreferences.getMediaAccessStatus('screen') === 'granted') return true
  // macOS 对「从未申请」也可能报告 denied；必须显式申请，才能出现在系统授权列表。
  api()?.requestCapture()
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') return true
  await explainPermission('ScreenCapture')
  return false
}

/** 只在用户使用空格穿透时申请；普通截图翻译不需要输入监控。 */
export async function ensureKeyMonitoring(): Promise<boolean> {
  if (!isMac) return true
  const cg = api()
  if (cg?.canListen()) return true
  cg?.requestListen()
  if (cg?.canListen()) return true
  await explainPermission('ListenEvent')
  return false
}

export function macSpaceDown(): boolean | null {
  const cg = api()
  // kCGEventSourceStateHIDSystemState = 1, kVK_Space = 49.
  return cg?.canListen() ? cg.keyState(1, 49) : null
}

export function configureMacOverlay(win: BrowserWindow) {
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
}
