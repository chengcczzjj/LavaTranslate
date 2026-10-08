// 自动更新：GitHub Releases（electron-updater，NSIS 安装包按块差量下载）
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/types'
import type { MsgKey } from '../shared/i18n'
import { t } from './i18n'

const CHECK_EVERY = 4 * 3600 * 1000

let state: UpdateState = { state: 'idle', version: app.getVersion() }
let listener: (s: UpdateState) => void = () => {}
let timer: NodeJS.Timeout | null = null
let enabled = () => true

function set(s: UpdateState) {
  state = s
  listener(updateState())
}

/** 提示语存词条，读的时候按当前界面语言翻译（切换语言后也对） */
const MSG_KEYS = new Set<string>(['upd.devBuild', 'upd.noRelease', 'upd.offline', 'upd.noNew'])

export function updateState(): UpdateState {
  if ('message' in state && state.message && MSG_KEYS.has(state.message)) return { ...state, message: t(state.message as MsgKey) }
  return state
}

export function initUpdater(opts: { enabled: () => boolean; onChange: (s: UpdateState) => void }) {
  enabled = opts.enabled
  listener = opts.onChange
  const version = app.getVersion()
  if (!app.isPackaged) {
    set({ state: 'disabled', version, message: 'upd.devBuild' })
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  let next = ''
  autoUpdater.on('checking-for-update', () => {
    if (state.state !== 'downloading' && state.state !== 'ready') set({ state: 'checking', version })
  })
  autoUpdater.on('update-available', (info) => {
    next = info.version
    set({ state: 'available', version, next, percent: 0 })
  })
  autoUpdater.on('update-not-available', () => set({ state: 'latest', version }))
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', version, next, percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version, next: info.version }))
  autoUpdater.on('error', (e) => {
    if (state.state !== 'ready') set(failed(e))
  })
  schedule()
}

function schedule() {
  if (timer) clearInterval(timer)
  if (!enabled()) return
  setTimeout(() => void check(), 20_000)
  timer = setInterval(() => void check(), CHECK_EVERY)
}

/** 设置里切换"自动更新"后调用 */
export function setAutoUpdate(on: boolean) {
  if (!app.isPackaged) return
  if (on) schedule()
  else if (timer) {
    clearInterval(timer)
    timer = null
  }
}

export async function check(): Promise<UpdateState> {
  if (!app.isPackaged) return state
  if (state.state === 'downloading' || state.state === 'ready') return state
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    set(failed(e))
  }
  return state
}

export function installNow() {
  if (state.state === 'ready') autoUpdater.quitAndInstall(true, true)
}

/** 仓库里还没有任何发布（404）不算失败 */
function failed(e: unknown): UpdateState {
  const version = app.getVersion()
  const msg = e instanceof Error ? e.message : String(e)
  if (/\b404\b/.test(msg)) return { state: 'latest', version, message: 'upd.noRelease' }
  return { state: 'error', version, message: friendly(e) }
}

function friendly(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::/i.test(msg)) return 'upd.offline'
  if (/404/.test(msg)) return 'upd.noNew'
  return msg.split('\n')[0].slice(0, 120)
}
