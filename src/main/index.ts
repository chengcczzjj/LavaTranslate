import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  Tray,
  type Display,
  type WebContents
} from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LANGUAGES,
  type CaptureFrame,
  type EngineStatus,
  type Language,
  type OcrLine,
  type ModelInfo,
  type ReplyEvent,
  type ReplyStartMsg,
  type OpenAISource,
  type PinPayload,
  type Rect,
  type Settings,
  type TranslateEvent,
  type TranslateRequestMsg
} from '../shared/types'
import { captureAll, cropRgba, rgbaToBgra, type DisplayCapture } from './capture'
import { claudeLoginStatus, findOpenAISources, resolveApiCredentials, resolveOpenAICredentials } from './credentials'
import { PaddleOcr } from './ocr'
import { refreshPrices, sortByPrice } from './pricing'
import { check as checkUpdate, initUpdater, installNow, setAutoUpdate, updateState } from './updater'
import { settings } from './settings'
import { ApiEngine, ClaudeCodeEngine, claudeExecutable, OpenAIEngine, TranslateError, type Engine } from './translator'
import { fakeModelServer, FixtureEngine, MockEngine, runAutotest, runEngineTest, runReview } from './devtest'
import { EventEmitter } from 'node:events'

const isDev = !app.isPackaged
const resources = isDev ? join(__dirname, '../../resources') : process.resourcesPath
const preload = join(__dirname, '../preload/index.js')
const AUTOTEST = !!process.env.LENS_AUTOTEST || !!process.env.LENS_REVIEW
const fixtureEngine = process.env.LENS_REVIEW ? new FixtureEngine() : null
const mockEngine = fixtureEngine ?? (process.env.LENS_MOCK ? new MockEngine() : null)
const pipeline = new EventEmitter()

// 自测用独立的数据目录：不读写用户配置，也不和已安装、正在运行的版本抢单实例锁
if (AUTOTEST || process.env.LENS_ENGINE_TEST) app.setPath('userData', join(app.getPath('temp'), 'lens-autotest'))
if (!app.requestSingleInstanceLock()) app.quit()

// 主进程未捕获的异常默认会弹出模态对话框并阻塞主线程；改为写日志
const logError = (kind: string, e: unknown) => {
  const line = `[${new Date().toISOString()}] ${kind}: ${e instanceof Error ? e.stack : String(e)}
`
  console.error(line)
  try {
    appendFileSync(join(app.getPath('userData'), 'error.log'), line)
  } catch {
    /* 忽略 */
  }
}
process.on('uncaughtException', (e) => logError('uncaughtException', e))
process.on('unhandledRejection', (e) => logError('unhandledRejection', e))
app.setAppUserModelId('com.lavatranslate.app')
// 隐藏的遮罩窗口也要及时绘制新截图
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

let tray: Tray | null = null
let settingsWin: BrowserWindow | null = null
let quitting = false
const ocr = new PaddleOcr(join(resources, 'models'))
let engine: Engine | null = null

// ------------------------------------------------------------------ 页面加载
function loadPage(win: BrowserWindow, page: 'overlay' | 'settings' | 'pin') {
  if (isDev && process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html`)
  else win.loadFile(join(__dirname, `../renderer/${page}.html`))
}

// ------------------------------------------------------------------ 引擎
function buildEngine(s: Settings): Engine | null {
  engine?.dispose()
  if (mockEngine) return (engine = mockEngine)
  if (s.engine === 'api') {
    const creds = resolveApiCredentials(s)
    engine = creds ? new ApiEngine(creds) : null
  } else if (s.engine === 'openai') {
    const creds = resolveOpenAICredentials(s)
    engine = creds && s.openaiModel ? new OpenAIEngine(creds, s.openaiModel) : null
  } else {
    // 安装包不带 Claude Code；本机没装时不创建引擎，界面会提示去设置
    engine = claudeExecutable() ? new ClaudeCodeEngine() : null
  }
  return engine
}

function engineStatus(): EngineStatus {
  const s = settings.get()
  if (s.engine === 'api') {
    const c = resolveApiCredentials(s)
    if (!c) return { engine: 'api', ok: false, detail: '未配置 API Key' }
    const host = c.baseURL ? new URL(c.baseURL).host : 'api.anthropic.com'
    const src = c.source === 'custom' ? '自定义' : c.source === 'claude-code' ? '读取自 Claude Code 配置' : '环境变量'
    return { engine: 'api', ok: true, detail: `${host} · ${src}` }
  }
  if (s.engine === 'openai') {
    const c = resolveOpenAICredentials(s)
    if (!c) return { engine: 'openai', ok: false, detail: '还没有填写 API Key' }
    if (!s.openaiModel) return { engine: 'openai', ok: false, detail: '请选择一个模型' }
    let host = c.baseURL
    try {
      host = new URL(c.baseURL).host
    } catch {
      /* 保持原样 */
    }
    return { engine: 'openai', ok: true, detail: `${s.openaiModel} · ${host}` }
  }
  if (!claudeExecutable()) return { engine: 'claude-code', ok: false, detail: '没有找到 Claude Code，请在设置里改用 OpenAI 兼容服务' }
  const st = claudeLoginStatus()
  if (!st.loggedIn) return { engine: 'claude-code', ok: false, detail: '未登录 Claude 账号' }
  if (st.expired) return { engine: 'claude-code', ok: false, detail: '登录已过期，需要重新登录' }
  return { engine: 'claude-code', ok: true, detail: st.subscription ? `已登录 · ${st.subscription.toUpperCase()} 订阅` : '已登录' }
}

// ------------------------------------------------------------------ 遮罩窗口
interface Overlay {
  win: BrowserWindow
  displayId: number
}
const overlays = new Map<number, Overlay>()
let captures = new Map<number, DisplayCapture>()
let overlayActive = false
let releaseTimer: NodeJS.Timeout | null = null

function createOverlay(display: Display): Overlay {
  const { x, y, width, height } = display.bounds
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    roundedCorners: false,
    thickFrame: false,
    webPreferences: { preload, sandbox: false, backgroundThrottling: false, spellcheck: false, offscreen: AUTOTEST }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenu(null)
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      hideOverlays()
    }
  })
  loadPage(win, 'overlay')
  return { win, displayId: display.id }
}

function syncOverlays() {
  const displays = screen.getAllDisplays()
  const ids = new Set(displays.map((d) => d.id))
  for (const [id, o] of overlays) {
    if (!ids.has(id)) {
      o.win.destroy()
      overlays.delete(id)
    }
  }
  for (const d of displays) {
    const o = overlays.get(d.id)
    if (!o) overlays.set(d.id, createOverlay(d))
    else o.win.setBounds(d.bounds)
  }
}

function overlayOf(wc: WebContents): Overlay | undefined {
  for (const o of overlays.values()) if (o.win.webContents === wc) return o
  return undefined
}

let tHotkey = 0
async function startCapture() {
  tHotkey = Date.now()
  if (overlayActive) {
    hideOverlays()
    return
  }
  overlayActive = true
  if (releaseTimer) clearTimeout(releaseTimer)
  // 预热失败不能挡住截图：翻译时还会再报一次，届时在工具条上提示
  try {
    engine?.warm(settings.get().model)
  } catch (e) {
    logError('warm', e)
  }
  try {
    syncOverlays()
    const caps = await captureAll()
    if (process.env.LENS_SHOWTEST) console.log('[show] captured', Date.now() - tHotkey, 'ms')
    presentCaptures(caps)
  } catch (e) {
    // 出错一定要复位，否则之后每次按快捷键都只会在"关闭"分支里空转
    overlayActive = false
    logError('capture', e)
    notify('截图失败', e instanceof Error ? e.message : String(e))
  }
}

function presentCaptures(caps: DisplayCapture[]) {
  const s = settings.get()
  overlayActive = true
  captures = new Map(caps.map((c) => [c.display.id, c]))
  const cursor = screen.getCursorScreenPoint()
  const cursorDisplay = screen.getDisplayNearestPoint(cursor)
  for (const cap of caps) {
    const o = overlays.get(cap.display.id)
    if (!o) continue
    const b = cap.display.bounds
    const frame: CaptureFrame = {
      displayId: cap.display.id,
      width: cap.width,
      height: cap.height,
      scale: cap.scale,
      pixels: cap.rgba,
      cursor: cap.display.id === cursorDisplay.id ? { x: cursor.x - b.x, y: cursor.y - b.y } : null,
      windows: cap.windows,
      targetLang: s.targetLang,
      displayMode: s.displayMode,
      hotkey: s.hotkey,
      replyAssist: s.replyAssist,
      replyTone: s.replyTone
    }
    o.win.webContents.send('overlay:frame', frame)
  }
}

/** 渲染进程画好截图后才显示窗口，避免闪出上一帧 */
ipcMain.on('overlay:frame-ready', (e) => {
  const o = overlayOf(e.sender)
  if (process.env.LENS_SHOWTEST && o) console.log('[show] frame-ready display', o.displayId, Date.now() - tHotkey, 'ms')
  if (!o || !overlayActive) return
  if (AUTOTEST) return o.win.webContents.send('overlay:shown')
  const display = screen.getAllDisplays().find((d) => d.id === o.displayId)
  if (display) {
    o.win.setBounds(display.bounds)
    o.win.setBounds(display.bounds)
  }
  o.win.setOpacity(0)
  o.win.show()
  o.win.setAlwaysOnTop(true, 'screen-saver')
  const cursor = screen.getCursorScreenPoint()
  if (screen.getDisplayNearestPoint(cursor).id === o.displayId) {
    o.win.focus()
    o.win.webContents.focus()
  }
  o.win.webContents.send('overlay:shown')
})

ipcMain.on('overlay:visible', (e) => {
  const o = overlayOf(e.sender)
  if (o && overlayActive) o.win.setOpacity(1)
  if (process.env.LENS_SHOWTEST && o) console.log('[show] visible display', o.displayId, Date.now() - tHotkey, 'ms', 'focused', o.win.isFocused(), 'bounds', JSON.stringify(o.win.getBounds()))
})

ipcMain.on('overlay:focus', (e) => {
  const o = overlayOf(e.sender)
  if (o) {
    o.win.focus()
    o.win.webContents.focus()
  }
})

function fadeOut(win: BrowserWindow, ms: number) {
  return new Promise<void>((resolve) => {
    const start = Date.now()
    const tick = () => {
      if (win.isDestroyed()) return resolve()
      const t = Math.min(1, (Date.now() - start) / ms)
      win.setOpacity(1 - t * t)
      if (t < 1) setTimeout(tick, 8)
      else resolve()
    }
    tick()
  })
}

async function hideOverlays(immediate = false) {
  if (!overlayActive) return
  overlayActive = false
  for (const ctl of translations.values()) ctl.abort()
  translations.clear()
  const visible = [...overlays.values()].filter((o) => o.win.isVisible())
  await Promise.all(visible.map((o) => (immediate ? Promise.resolve() : fadeOut(o.win, 140))))
  for (const o of visible) {
    o.win.hide()
    o.win.webContents.send('overlay:reset')
  }
  // 截图数据保留片刻，便于连续操作；之后释放内存
  releaseTimer = setTimeout(() => {
    captures.clear()
    ocrCache.clear()
  }, 30_000)
}

ipcMain.on('overlay:close', () => hideOverlays())

// ------------------------------------------------------------------ 翻译流程
const translations = new Map<number, AbortController>()
const ocrCache = new Map<string, OcrLine[]>()

ipcMain.on('translate:start', async (e, msg: TranslateRequestMsg) => {
  const sender = e.sender
  const send = (event: TranslateEvent) => {
    if (!sender.isDestroyed()) sender.send('translate:event', { requestId: msg.requestId, event })
  }
  translations.get(sender.id)?.abort()
  const ctl = new AbortController()
  translations.set(sender.id, ctl)

  const cap = captures.get(msg.displayId)
  if (!cap) return send({ type: 'error', message: '截图已失效，请重新截图', code: 'unknown' })
  const rect = clampRect(msg.rect, cap.width, cap.height)
  if (rect.w < 4 || rect.h < 4) return send({ type: 'error', message: '选区太小', code: 'no-text' })
  const t0 = Date.now()
  const crop = cropRgba(cap.rgba, cap.width, rect)

  // 1. OCR（GPU）
  const key = `${msg.displayId}:${rect.x},${rect.y},${rect.w},${rect.h}`
  let lines = msg.reuseOcr ? ocrCache.get(key) : undefined
  if (!lines) {
    try {
      lines = await ocr.recognize({ data: crop, width: rect.w, height: rect.h })
    } catch (err) {
      return send({ type: 'error', message: `文字识别失败：${err}`, code: 'unknown' })
    }
    ocrCache.set(key, lines)
  }
  if (ctl.signal.aborted) return
  send({ type: 'ocr', lines, ms: Date.now() - t0 })
  if (!lines.length) return send({ type: 'error', message: '没有识别到文字', code: 'no-text' })

  // 2. Claude
  const s = settings.get()
  const eng = engine ?? buildEngine(s)
  if (!eng) return send({ type: 'error', message: engineStatus().detail, code: 'config' })
  const target = LANGUAGES.find((l) => l.code === msg.targetLang) ?? LANGUAGES[0]
  const { image, factor } = encodeForModel(crop, rect.w, rect.h)
  const promptLines = factor === 1 ? lines : lines.map((l) => ({ ...l, box: scaleRect(l.box, factor) }))
  try {
    const res = await eng.translate(
      { image, lines: promptLines, target, styleHint: s.styleHint, model: s.model },
      send,
      ctl.signal
    )
    send({ type: 'done', ms: Date.now() - t0, firstTokenMs: res.firstTokenMs, engine: eng.name, usage: res.usage })
    pipeline.emit('end', { ok: true, ms: Date.now() - t0, ocrMs: ocr.timing, firstTokenMs: res.firstTokenMs, usage: res.usage })
  } catch (err) {
    if (ctl.signal.aborted) return
    const te = err instanceof TranslateError ? err : new TranslateError(String(err), 'unknown')
    send({ type: 'error', message: te.message, code: te.code })
    pipeline.emit('end', { ok: false, error: te.message })
  } finally {
    if (translations.get(sender.id) === ctl) translations.delete(sender.id)
  }
})

// ------------------------------------------------------------------ 回复助手
const replies = new Map<number, AbortController>()

/** 把模型识别出的语言代码对应到语言表；表里没有的直接用代码与模型给的名字 */
function langFor(code: string, name?: string): Language {
  const c = code.toLowerCase()
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === c)
  if (exact) return exact
  if (c.startsWith('zh')) return LANGUAGES.find((l) => l.code === (/(tw|hk|hant|mo)/.test(c) ? 'zh-Hant' : 'zh-Hans'))!
  const base = LANGUAGES.find((l) => l.code === c.split('-')[0])
  return base ?? { code, name: name ?? code, native: name ?? code }
}

ipcMain.on('reply:start', async (e, msg: ReplyStartMsg) => {
  const sender = e.sender
  const send = (event: ReplyEvent) => {
    if (!sender.isDestroyed()) sender.send('reply:event', { requestId: msg.requestId, event })
  }
  replies.get(sender.id)?.abort()
  const ctl = new AbortController()
  replies.set(sender.id, ctl)
  const s = settings.get()
  const eng = engine ?? buildEngine(s)
  if (!eng) return send({ type: 'error', message: engineStatus().detail })
  const t0 = Date.now()
  try {
    await eng.reply(
      {
        text: msg.text,
        from: langFor(s.targetLang),
        to: langFor(msg.to, msg.toName),
        context: msg.context,
        tone: msg.tone,
        model: s.engine === 'openai' ? s.openaiModel : s.model
      },
      (d) => send({ type: 'delta', text: d }),
      ctl.signal
    )
    if (!ctl.signal.aborted) send({ type: 'done', ms: Date.now() - t0 })
  } catch (err) {
    if (ctl.signal.aborted) return
    send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  } finally {
    if (replies.get(sender.id) === ctl) replies.delete(sender.id)
  }
})

ipcMain.on('reply:cancel', (e) => {
  replies.get(e.sender.id)?.abort()
  replies.delete(e.sender.id)
})

ipcMain.on('translate:cancel', (e) => {
  translations.get(e.sender.id)?.abort()
  translations.delete(e.sender.id)
})

function clampRect(r: Rect, W: number, H: number): Rect {
  const x = Math.max(0, Math.min(W - 1, Math.round(r.x)))
  const y = Math.max(0, Math.min(H - 1, Math.round(r.y)))
  return { x, y, w: Math.max(1, Math.min(W - x, Math.round(r.w))), h: Math.max(1, Math.min(H - y, Math.round(r.h))) }
}

function scaleRect(r: Rect, f: number): Rect {
  return { x: r.x * f, y: r.y * f, w: r.w * f, h: r.h * f }
}

/** 给模型的图片：太大则缩到长边 1568，太小则放大 2 倍；大图用 JPEG 减少上传体积 */
function encodeForModel(rgba: Uint8Array, w: number, h: number) {
  let img = nativeImage.createFromBitmap(rgbaToBgra(rgba), { width: w, height: h })
  const long = Math.max(w, h)
  let factor = 1
  if (long > 1568) factor = 1568 / long
  else if (long < 400) factor = 2
  if (factor !== 1) img = img.resize({ width: Math.round(w * factor), height: Math.round(h * factor), quality: 'best' })
  const size = img.getSize()
  const big = size.width * size.height > 700_000
  const buf = big ? img.toJPEG(90) : img.toPNG()
  return {
    image: { base64: buf.toString('base64'), mediaType: (big ? 'image/jpeg' : 'image/png') as 'image/jpeg' | 'image/png', width: size.width, height: size.height },
    factor
  }
}

// ------------------------------------------------------------------ 其他操作
ipcMain.on('clipboard:text', (_e, text: string) => void clipboard.writeText(text))

ipcMain.handle('image:copy', async (e, rect: Rect) => {
  const o = overlayOf(e.sender)
  if (!o) return false
  const img = await o.win.webContents.capturePage(roundRect(rect))
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })])
  return true
})

ipcMain.handle('image:save', async (e, rect: Rect) => {
  const o = overlayOf(e.sender)
  if (!o) return false
  const img = await o.win.webContents.capturePage(roundRect(rect))
  o.win.setAlwaysOnTop(false)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const res = await dialog.showSaveDialog(o.win, {
    title: '保存翻译截图',
    defaultPath: join(app.getPath('pictures'), `LavaTranslate_${stamp}.png`),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  })
  if (!o.win.isDestroyed()) o.win.setAlwaysOnTop(true, 'screen-saver')
  if (res.canceled || !res.filePath) return false
  writeFileSync(res.filePath, img.toPNG())
  return true
})

function roundRect(r: Rect) {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h) }
}

// ------------------------------------------------------------------ 钉图窗口
const PIN_MARGIN = 18
const pins = new Map<number, { win: BrowserWindow; payload: PinPayload }>()

ipcMain.on('pin:create', (e, payload: PinPayload) => {
  const o = overlayOf(e.sender)
  const display = o && screen.getAllDisplays().find((d) => d.id === o.displayId)
  const ox = display?.bounds.x ?? 0
  const oy = display?.bounds.y ?? 0
  const r = payload.screenRect
  const win = new BrowserWindow({
    x: Math.round(ox + r.x - PIN_MARGIN),
    y: Math.round(oy + r.y - PIN_MARGIN),
    width: Math.round(r.w + PIN_MARGIN * 2),
    height: Math.round(r.h + PIN_MARGIN * 2),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: { preload, sandbox: false, spellcheck: false }
  })
  win.setAlwaysOnTop(true, 'floating')
  // 窗口销毁后不能再访问 webContents，先记下 id
  const id = win.webContents.id
  pins.set(id, { win, payload })
  win.on('closed', () => {
    pins.delete(id)
    clearInterval(drags.get(id))
    drags.delete(id)
  })
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('pin:data', payload)
  })
  loadPage(win, 'pin')
  ipcMain.once(`pin:ready:${id}`, () => {
    if (win.isDestroyed()) return
    win.showInactive()
    hideOverlays(true)
  })
})

ipcMain.on('pin:ready', (e) => ipcMain.emit(`pin:ready:${e.sender.id}`))
ipcMain.on('pin:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

// 拖动：主进程以 60fps 跟随鼠标，比 -webkit-app-region 更跟手且不吞掉鼠标事件
const drags = new Map<number, NodeJS.Timeout>()
ipcMain.on('pin:drag', (e, on: boolean) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  const id = e.sender.id
  clearInterval(drags.get(id))
  drags.delete(id)
  if (!on) return
  const start = screen.getCursorScreenPoint()
  const [wx, wy] = win.getPosition()
  drags.set(
    id,
    setInterval(() => {
      if (win.isDestroyed()) return clearInterval(drags.get(id))
      const p = screen.getCursorScreenPoint()
      win.setPosition(wx + p.x - start.x, wy + p.y - start.y)
    }, 8)
  )
})

ipcMain.on('pin:zoom', (e, factor: number) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const pin = pins.get(e.sender.id)
  if (!win || !pin) return
  const r = pin.payload.screenRect
  const b = win.getBounds()
  const w = Math.round(r.w * factor + PIN_MARGIN * 2)
  const h = Math.round(r.h * factor + PIN_MARGIN * 2)
  const cursor = screen.getCursorScreenPoint()
  // 以鼠标为中心缩放
  const fx = (cursor.x - b.x) / b.width
  const fy = (cursor.y - b.y) / b.height
  win.setBounds({ x: Math.round(cursor.x - fx * w), y: Math.round(cursor.y - fy * h), width: w, height: h })
})

// ------------------------------------------------------------------ 设置窗口
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return
  }
  settingsWin = new BrowserWindow({
    width: 820,
    height: 620,
    minWidth: 720,
    minHeight: 540,
    show: false,
    title: 'LavaTranslate',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e8e8ee' : '#3a3a44', height: 48 },
    backgroundMaterial: 'mica',
    backgroundColor: '#00000000',
    icon: join(resources, 'icon.png'),
    webPreferences: { preload, sandbox: false, spellcheck: false }
  })
  settingsWin.setMenu(null)
  settingsWin.once('ready-to-show', () => settingsWin?.show())
  settingsWin.on('closed', () => (settingsWin = null))
  loadPage(settingsWin, 'settings')
}

nativeTheme.on('updated', () => {
  settingsWin?.setTitleBarOverlay({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e8e8ee' : '#3a3a44', height: 48 })
})

ipcMain.handle('settings:get', () => settings.public())
ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
  settings.update(patch)
  return settings.public()
})
ipcMain.handle('engine:status', () => engineStatus())
/** 本机已有的 OpenAI 兼容凭据（Codex 配置、CC Switch），可一键导入 */
ipcMain.handle('openai:sources', (): OpenAISource[] =>
  findOpenAISources().map((f) => ({ id: f.id, label: f.label, baseURL: f.baseURL, hasKey: !!f.apiKey, model: f.model }))
)
ipcMain.handle('openai:import', (_e, id: string) => {
  const src = findOpenAISources().find((f) => f.id === id)
  if (!src) return settings.public()
  settings.update({ engine: 'openai', openaiBaseUrl: src.baseURL, openaiKey: src.apiKey, openaiModel: '' })
  return settings.public()
})
/** 拉取服务端模型列表，按一次翻译的估算费用从低到高排序（价格来自 models.dev） */
ipcMain.handle('openai:models', async (): Promise<{ ok: boolean; models: ModelInfo[]; message?: string }> => {
  const s = settings.get()
  const c = resolveOpenAICredentials(s)
  if (!c) return { ok: false, models: [], message: '请先填写 API Key' }
  const bundled = join(resources, 'model-prices.json')
  try {
    // 价格库在后台刷新，不拖慢列表；这次先用缓存或安装包内置的价格
    void refreshPrices(bundled)
    const ids = await new OpenAIEngine(c, s.openaiModel || 'x').listModels()
    return { ok: true, models: sortByPrice(ids, bundled) }
  } catch (e) {
    return { ok: false, models: [], message: e instanceof Error ? e.message : String(e) }
  }
})
ipcMain.handle('app:info', () => ({ version: app.getVersion() }))
ipcMain.handle('update:state', () => updateState())
ipcMain.handle('update:check', () => checkUpdate())
ipcMain.on('update:install', () => {
  quitting = true
  installNow()
})
ipcMain.handle('ocr:info', async () => {
  await ocr.init().catch(() => {})
  return ocr.provider === 'dml' ? 'GPU 加速 · DirectML' : 'CPU 推理'
})
ipcMain.on('capture:start', () => void startCapture())
ipcMain.on('settings:open', () => {
  hideOverlays(true)
  openSettings()
})

ipcMain.handle('engine:test', async () => {
  const s = settings.get()
  const eng = engine ?? buildEngine(s)
  if (!eng) return { ok: false, message: engineStatus().detail }
  const t0 = Date.now()
  const ctl = new AbortController()
  // 一张写着 "Hello, world" 的小图走一遍完整流程
  const img = nativeImage.createFromPath(join(resources, 'test.png'))
  const size = img.getSize()
  try {
    let got = ''
    await eng.translate(
      {
        image: { base64: img.toPNG().toString('base64'), mediaType: 'image/png', width: size.width, height: size.height },
        lines: [{ id: 1, text: 'Hello, world', score: 1, box: { x: 8, y: 8, w: size.width - 16, h: size.height - 16 } }],
        target: LANGUAGES.find((l) => l.code === s.targetLang) ?? LANGUAGES[0],
        styleHint: '',
        model: s.model
      },
      (ev) => {
        if (ev.type === 'block') got = ev.block.translation
      },
      ctl.signal
    )
    return { ok: true, message: `「Hello, world」→「${got}」 · ${((Date.now() - t0) / 1000).toFixed(1)}s` }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
})

/** 打开终端执行 claude auth login */
ipcMain.on('engine:login', () => {
  const exe = claudeExe()
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^ANTHROPIC_|^CLAUDE_CODE_|^CLAUDECODE$/.test(k)) env[k] = v
  spawn('cmd.exe', ['/c', 'start', 'Claude 登录', 'cmd', '/k', exe, 'auth', 'login'], { detached: true, stdio: 'ignore', env }).unref()
})

function claudeExe() {
  return claudeExecutable() ?? 'claude'
}

// ------------------------------------------------------------------ 快捷键 / 托盘
let registeredHotkey = ''
function registerHotkey(hotkey: string): boolean {
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
  registeredHotkey = ''
  try {
    if (globalShortcut.register(hotkey, () => void startCapture())) {
      registeredHotkey = hotkey
      return true
    }
  } catch {
    /* 非法组合 */
  }
  return false
}

ipcMain.handle('hotkey:set', (_e, hotkey: string) => {
  const prev = settings.get().hotkey
  if (registerHotkey(hotkey)) {
    settings.update({ hotkey })
    updateTray()
    return { ok: true }
  }
  registerHotkey(prev)
  return { ok: false, message: '该快捷键已被其他程序占用或无效' }
})

ipcMain.handle('hotkey:suspend', (_e, on: boolean) => {
  // 录制快捷键时暂停全局热键
  if (on) globalShortcut.unregisterAll()
  else registerHotkey(settings.get().hotkey)
})

function updateTray() {
  if (!tray) return
  const s = settings.get()
  tray.setToolTip(`LavaTranslate · ${s.hotkey.replace(/\+/g, ' + ')}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      // 快捷键用 accelerator 显示（右对齐）；不在这里注册，全局热键另有 globalShortcut。
      // 菜单里不放勾选项：有勾选项时 Windows 会在左侧预留一整列空白（开机启动在设置里）
      { label: '截图翻译', accelerator: s.hotkey, registerAccelerator: false, click: () => void startCapture() },
      { type: 'separator' },
      ...(updateState().state === 'ready'
        ? [{ label: `重启并更新到 v${(updateState() as { next: string }).next}`, click: () => ((quitting = true), installNow()) }, { type: 'separator' as const }]
        : []),
      { label: '设置…', click: openSettings },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
}

function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body, icon: join(resources, 'icon.png') }).show()
}

// ------------------------------------------------------------------ 启动
app.on('second-instance', () => openSettings())

/**
 * 旧名称「Lens 截图翻译」的配置搬到新目录。
 * Key 不搬：safeStorage 的密钥存在各自数据目录的 Local State 里，换了目录就解不开，需要重新填写。
 * 旧版默认的「Claude 账号」依赖本机的 Claude Code，没装时改用 OpenAI 兼容服务。
 */
function migrateLegacy() {
  if (AUTOTEST || process.env.LENS_ENGINE_TEST) return
  const dir = app.getPath('userData')
  const legacy = join(app.getPath('appData'), 'Lens 截图翻译', 'settings.json')
  if (existsSync(join(dir, 'settings.json')) || !existsSync(legacy)) return
  try {
    const old = JSON.parse(readFileSync(legacy, 'utf8')) as Partial<Settings> & { openaiSource?: string }
    delete old.openaiSource
    if (old.apiKey?.startsWith('enc:')) old.apiKey = ''
    if (old.openaiKey?.startsWith('enc:')) old.openaiKey = ''
    if (old.engine === 'claude-code' && !claudeExecutable()) old.engine = 'openai'
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(old, null, 2))
  } catch (e) {
    logError('migrate', e)
  }
}

app.whenReady().then(async () => {
  migrateLegacy()
  const s = settings.load()
  buildEngine(s)
  void ocr.init()
  syncOverlays()
  screen.on('display-added', syncOverlays)
  screen.on('display-removed', syncOverlays)
  screen.on('display-metrics-changed', syncOverlays)

  tray = new Tray(nativeImage.createFromPath(join(resources, 'tray.png')))
  tray.on('click', () => void startCapture())
  updateTray()

  initUpdater({
    enabled: () => settings.get().autoUpdate,
    onChange: (st) => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update:state', st)
      if (st.state === 'ready') {
        updateTray()
        notify('新版本已就绪', `v${st.next} 已下载完成，退出时自动安装；也可以在托盘菜单里立即重启更新`)
      }
    }
  })

  const ok = registerHotkey(s.hotkey)
  settings.onChange((next, prev) => {
    const keys: (keyof Settings)[] = ['engine', 'apiKey', 'apiBaseUrl', 'model', 'openaiBaseUrl', 'openaiKey', 'openaiModel']
    if (keys.some((k) => next[k] !== prev[k])) buildEngine(next)
    if (next.launchAtLogin !== prev.launchAtLogin) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin })
    if (next.autoUpdate !== prev.autoUpdate) setAutoUpdate(next.autoUpdate)
    updateTray()
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed', settings.public())
  })

  if (process.env.LENS_SHOWTEST) {
    for (const [at, fn] of [
      [2500, () => void startCapture()],
      [4000, () => void hideOverlays()],
      [5000, () => void startCapture()],
      [6500, () => void hideOverlays()],
      [7500, () => void startCapture()],
      [9000, () => void hideOverlays().then(() => app.quit())]
    ] as [number, () => void][])
      setTimeout(fn, at)
    return
  }

  if (process.env.LENS_ENGINE_TEST) {
    const img = nativeImage.createFromPath(join(process.env.LENS_AUTOTEST_ROOT || app.getAppPath(), '.scratch', process.env.LENS_ENGINE_IMAGE ?? 'test1.png'))
    const size = img.getSize()
    const bgra = img.toBitmap()
    const rgba = new Uint8Array(bgra.length)
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i] = bgra[i + 2]
      rgba[i + 1] = bgra[i + 1]
      rgba[i + 2] = bgra[i]
      rgba[i + 3] = 255
    }
    const lines = await ocr.recognize({ data: rgba, width: size.width, height: size.height })
    const enc = encodeForModel(rgba, size.width, size.height)
    const kind = process.env.LENS_ENGINE_TEST
    const fake = process.env.LENS_OPENAI_FAKE ? await fakeModelServer() : null
    const eng =
      kind === 'api'
        ? buildEngine({ ...s, engine: 'api' })
        : kind === 'openai'
          ? (() => {
              // LENS_OPENAI_SOURCE=ccs:<名称> / codex：直接用本机 Codex / CC Switch 的凭据（自测数据目录里没有 Key）
              const all = process.env.LENS_OPENAI_SOURCE ? findOpenAISources() : []
              const src = all.find((f) => f.id === process.env.LENS_OPENAI_SOURCE)
              if (process.env.LENS_OPENAI_SOURCE && !src) console.log('[engine] sources:', all.map((f) => f.id).join(', '))
              // LENS_OPENAI_FAKE=1：本地假服务（只有 Chat Completions），检查接口自动回退
              const base = fake ? { openaiBaseUrl: fake.url, openaiKey: 'sk-test-0000' } : src ? { openaiBaseUrl: src.baseURL, openaiKey: src.apiKey } : {}
              return buildEngine({ ...s, ...base, engine: 'openai', openaiModel: process.env.LENS_OPENAI_MODEL ?? s.openaiModel })
            })()
          : new ClaudeCodeEngine()
    // LENS_OPENAI_API=chat：直接走 Chat Completions
    if (eng && process.env.LENS_OPENAI_API === 'chat') (eng as unknown as { api: string }).api = 'chat'
    if (!eng) {
      console.log('[engine] no api credentials')
      return app.quit()
    }
    void runEngineTest(eng, lines, enc.image)
    return
  }

  if (process.env.LENS_REVIEW) {
    await ocr.init()
    const display = screen.getPrimaryDisplay()
    setTimeout(() => {
      void runReview({
        display,
        mock: null,
        engine: fixtureEngine!,
        scenarios: process.env.LENS_REVIEW === '1' ? [] : process.env.LENS_REVIEW!.split(','),
        setTarget: (code) => settings.update({ targetLang: code }),
        setSettings: (p) => {
          settings.update(p)
        },
        openSettings: () => {
          openSettings()
          return settingsWin!
        },
        overlayWin: () => overlays.get(display.id)!.win,
        inject: async (cap) => {
          syncOverlays()
          presentCaptures([cap])
        },
        waitDone: () => new Promise((resolve) => pipeline.once('end', () => resolve()))
      })
    }, 1500)
    return
  }

  if (AUTOTEST) {
    await ocr.init()
    const display = screen.getPrimaryDisplay()
    setTimeout(() => {
      void runAutotest({
        display,
        openSettings: () => {
          openSettings()
          return settingsWin!
        },
        mock: mockEngine instanceof MockEngine ? mockEngine : null,
        setSettings: (p) => {
          settings.update(p)
        },
        overlayWin: () => overlays.get(display.id)!.win,
        inject: async (cap) => {
          syncOverlays()
          presentCaptures([cap])
        },
        waitDone: () =>
          new Promise((resolve) =>
            pipeline.once('end', (r) => {
              console.log('[autotest] pipeline', JSON.stringify(r))
              resolve()
            })
          )
      })
    }, 1500)
    return
  }

  if (!s.firstRunDone) {
    openSettings()
    settings.update({ firstRunDone: true })
  } else if (!ok) {
    notify('快捷键注册失败', `${s.hotkey} 已被占用，请在设置中更换`)
    openSettings()
  } else {
    notify('LavaTranslate 已在后台运行', `按 ${s.hotkey.replace(/\+/g, ' + ')} 框选屏幕任意区域即可翻译`)
  }
})

app.on('window-all-closed', () => {
  /* 常驻托盘 */
})

app.on('before-quit', () => {
  quitting = true
  engine?.dispose()
  globalShortcut.unregisterAll()
})

