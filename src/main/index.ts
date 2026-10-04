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
  shell,
  Tray,
  type Display,
  type WebContents
} from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  LANGUAGES,
  providerInfo,
  type CaptureFrame,
  type EngineStatus,
  type Language,
  type OcrLine,
  type ModelInfo,
  type ReplyEvent,
  type ReplyStartMsg,
  type OpenAISource,
  type PinPayload,
  type ProviderId,
  type Rect,
  type Settings,
  type SettingsPatch,
  type TranslateEvent,
  type TranslateRequestMsg
} from '../shared/types'
import { captureAll, cropRgba, rgbaToBgra, type DisplayCapture } from './capture'
import { chatgptSession, detectProvider, findOpenAISources, resolveProvider } from './credentials'
import { PaddleOcr } from './ocr'
import { refreshPrices, sortByPrice } from './pricing'
import { check as checkUpdate, initUpdater, installNow, setAutoUpdate, updateState } from './updater'
import { settings } from './settings'
import { OpenAIEngine, TranslateError, type Engine } from './translator'
import { cancelSignIn, listPlanModels, refresh as refreshChatGPT, signIn as signInChatGPT } from './chatgpt'
import { fakeModelServer, FixtureEngine, MockEngine, runAutotest, runEngineTest, runReview } from './devtest'
import { EventEmitter } from 'node:events'

const isDev = !app.isPackaged
const resources = isDev ? join(__dirname, '../../resources') : process.resourcesPath
const preload = join(__dirname, '../preload/index.js')
/** 窗口图标：.ico 含 16~256 多种尺寸，任务栏、Alt+Tab 都清晰 */
const appIcon = join(resources, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
const AUTOTEST = !!process.env.LENS_AUTOTEST || !!process.env.LENS_REVIEW
const fixtureEngine = process.env.LENS_REVIEW ? new FixtureEngine() : null
const mockEngine = fixtureEngine ?? (process.env.LENS_MOCK ? new MockEngine() : null)
const pipeline = new EventEmitter()

// 自测用独立的数据目录：不读写用户配置，也不和已安装、正在运行的版本抢单实例锁
if (AUTOTEST || process.env.LENS_ENGINE_TEST || process.env.LENS_DETECT_TEST) app.setPath('userData', join(app.getPath('temp'), 'lens-autotest'))
// LENS_AUTOTEST_SEED=<settings.json>：自测前放一份指定的设置（检查旧格式迁移等）
if (AUTOTEST && process.env.LENS_AUTOTEST_SEED) {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(join(app.getPath('userData'), 'settings.json'), readFileSync(process.env.LENS_AUTOTEST_SEED))
}
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
// 开发 / 测试运行用另一个 ID：同一个 ID 会和已安装的版本归成一组，任务栏就可能显示 electron.exe 的图标
app.setAppUserModelId(app.isPackaged ? 'com.lavatranslate.app' : 'com.lavatranslate.app.dev')
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
  engine = engineFor(s)
  return engine
}

/** 按当前服务创建引擎；没填 Key 或没选模型时返回 null */
function engineFor(s: Settings, id = s.provider): Engine | null {
  const r = resolveProvider(s, id)
  if (!r || !r.model) return null
  return new OpenAIEngine({ baseURL: r.baseURL, apiKey: r.apiKey }, r.model, { api: r.info.api, chatExtra: r.info.chatExtra })
}

/** ChatGPT 登录：令牌快过期时先刷新再用 */
async function ensureFreshToken() {
  const s = settings.get()
  if (s.provider !== 'chatgpt') return
  const sess = chatgptSession(s)
  if (!sess || sess.expiresAt - Date.now() > 120_000) return
  try {
    const next = await refreshChatGPT(sess)
    settings.update({ providers: { chatgpt: { key: JSON.stringify(next) } } })
  } catch (e) {
    logError('chatgpt refresh', e)
  }
}

function engineStatus(): EngineStatus {
  const s = settings.get()
  const info = providerInfo(s.provider)
  const r = resolveProvider(s)
  if (!r)
    return {
      provider: info.id,
      ok: false,
      detail: info.id === 'chatgpt' ? '还没有登录 ChatGPT' : info.id === 'custom' && s.providers.custom?.key ? '还没有填写接口地址' : '还没有填写 API Key'
    }
  if (!r.model) return { provider: info.id, ok: false, detail: `${info.name} · 请选择一个模型` }
  let where = info.name
  if (info.id === 'custom' || s.providers[info.id]?.baseUrl) {
    try {
      where = new URL(r.baseURL).host
    } catch {
      where = r.baseURL
    }
  }
  if (info.id === 'chatgpt') where = `ChatGPT 会员 · ${s.providers.chatgpt?.label ?? '已登录'}`
  return { provider: info.id, ok: true, detail: `${r.model} · ${where}` }
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
    icon: appIcon,
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
/** 连按两次快捷键的间隔上限；比键盘自动重复的延迟（约 500ms）短，按住不放不会误触发 */
const DOUBLE_PRESS_MS = 400
let lastHotkey = 0
/** 截图还没显示出来时就连按了第二次：显示时直接进入输入翻译 */
let quickPending = false
let framesShown = false
let hiding: Promise<void> | null = null

function onHotkey() {
  const now = Date.now()
  const double = now - lastHotkey < DOUBLE_PRESS_MS
  lastHotkey = double ? 0 : now
  if (double) startQuick()
  else void startCapture()
}

/** 直接输入一句话翻译（不框选） */
function startQuick() {
  if (overlayActive && framesShown) {
    // 输入框显示在鼠标所在的屏；那块屏没有截图时用第一块
    const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
    const here = captures.has(cursor) ? cursor : [...captures.keys()][0]
    for (const o of overlays.values()) {
      if (!captures.has(o.displayId)) continue
      o.win.webContents.send('overlay:quick', o.displayId === here)
      if (o.displayId === here && o.win.isVisible()) {
        o.win.focus()
        o.win.webContents.focus()
      }
    }
    return
  }
  quickPending = true
  if (!overlayActive) void startCapture()
}

async function startCapture() {
  tHotkey = Date.now()
  if (overlayActive) {
    hideOverlays()
    return
  }
  if (hiding) await hiding
  overlayActive = true
  if (releaseTimer) clearTimeout(releaseTimer)
  // 预热失败不能挡住截图：翻译时还会再报一次，届时在工具条上提示
  try {
    engine?.warm()
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
      replyTone: s.replyTone,
      quick: quickPending
    }
    o.win.webContents.send('overlay:frame', frame)
  }
  quickPending = false
  framesShown = true
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

function hideOverlays(immediate = false) {
  if (!overlayActive) return hiding ?? Promise.resolve()
  overlayActive = false
  framesShown = false
  hiding = doHide(immediate).finally(() => (hiding = null))
  return hiding
}

async function doHide(immediate: boolean) {
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

  // 2. 模型
  await ensureFreshToken()
  const s = settings.get()
  const eng = engine ?? buildEngine(s)
  if (!eng) return send({ type: 'error', message: engineStatus().detail, code: 'config' })
  const target = LANGUAGES.find((l) => l.code === msg.targetLang) ?? LANGUAGES[0]
  const { image, factor } = encodeForModel(crop, rect.w, rect.h)
  const promptLines = factor === 1 ? lines : lines.map((l) => ({ ...l, box: scaleRect(l.box, factor) }))
  try {
    const res = await eng.translate(
      { image, lines: promptLines, target, styleHint: s.styleHint },
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
  await ensureFreshToken()
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
        quick: msg.quick
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
    icon: appIcon,
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
    icon: appIcon,
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
ipcMain.handle('settings:set', (_e, patch: SettingsPatch) => {
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
  settings.update({ provider: 'custom', providers: { custom: { baseUrl: src.baseURL, key: src.apiKey, model: '' } } })
  return settings.public()
})
/** 打开服务商的网页（获取 Key、文档）；只允许 https */
ipcMain.on('shell:open', (_e, url: string) => {
  if (/^https:[/][/]/.test(url)) void shell.openExternal(url)
})
/** 拉取服务端模型列表，按一次翻译的估算费用从低到高排序（价格来自 models.dev） */
ipcMain.handle('models:list', async (_e, id?: ProviderId): Promise<{ ok: boolean; models: ModelInfo[]; message?: string }> => {
  await ensureFreshToken()
  const s = settings.get()
  const r = resolveProvider(s, id ?? s.provider)
  if (!r) return { ok: false, models: [], message: id === 'chatgpt' ? '请先登录 ChatGPT' : '请先填写 API Key' }
  const bundled = join(resources, 'model-prices.json')
  try {
    // 价格库在后台刷新，不拖慢列表；这次先用缓存或安装包内置的价格
    void refreshPrices(bundled)
    if (r.info.id === 'chatgpt') {
      // 会员额度内使用，不按 token 计费：不显示价格
      const ids = await listPlanModels(r.apiKey)
      return { ok: true, models: ids.map((m) => ({ id: m, input: null, output: null, vision: null, perCall: null })) }
    }
    const ids = await new OpenAIEngine({ baseURL: r.baseURL, apiKey: r.apiKey }, 'x').listModels()
    return { ok: true, models: sortByPrice(ids, bundled) }
  } catch (e) {
    return { ok: false, models: [], message: e instanceof Error ? e.message : String(e) }
  }
})
/** 识别 Key 属于哪家服务 */
ipcMain.handle('key:detect', (_e, key: string) => detectProvider(key))

/** 用 ChatGPT 账号登录：打开浏览器，等待回调 */
ipcMain.handle('chatgpt:signin', async (): Promise<{ ok: boolean; message?: string }> => {
  try {
    const s = settings.get()
    const sess = await signInChatGPT(s.installId, chatgptSession(s))
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.focus()
    settings.update({ provider: 'chatgpt', providers: { chatgpt: { key: JSON.stringify(sess), label: sess.email ?? '', baseUrl: '' } } })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
})
ipcMain.on('chatgpt:cancel', () => cancelSignIn())
ipcMain.handle('chatgpt:signout', () => {
  settings.update({ providers: { chatgpt: { key: '', label: '' } } })
  return settings.public()
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
  await ensureFreshToken()
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
        styleHint: ''
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

// ------------------------------------------------------------------ 快捷键 / 托盘
let registeredHotkey = ''
function registerHotkey(hotkey: string): boolean {
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
  registeredHotkey = ''
  try {
    if (globalShortcut.register(hotkey, onHotkey)) {
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
  const u = updateState()
  const upd: Electron.MenuItemConstructorOptions =
    u.state === 'ready'
      ? { label: `重启并更新到 v${u.next}`, click: () => ((quitting = true), installNow()) }
      : u.state === 'downloading' || u.state === 'available'
        ? { label: `正在下载 v${u.next}（${u.percent}%）`, enabled: false }
        : { label: u.state === 'checking' ? '正在检查更新…' : `检查更新（当前 v${u.version}）`, enabled: u.state !== 'checking' && u.state !== 'disabled', click: () => void checkUpdate() }
  tray.setToolTip(`LavaTranslate · ${s.hotkey.replace(/\+/g, ' + ')}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      // 快捷键用 accelerator 显示（右对齐）；不在这里注册，全局热键另有 globalShortcut。
      // 菜单里不放勾选项：有勾选项时 Windows 会在左侧预留一整列空白（开机启动在设置里）
      { label: '截图翻译', accelerator: s.hotkey, registerAccelerator: false, click: () => void startCapture() },
      { label: '输入文字翻译（连按两次快捷键）', click: () => startQuick() },
      { type: 'separator' },
      { label: '设置…（双击图标）', click: openSettings },
      upd,
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  )
}

function notify(title: string, body: string) {
  // 未打包时 Electron 发通知会在开始菜单自动建一个指向 electron.exe 的 Electron.lnk，测试时不发
  if (!app.isPackaged) return console.log('[notify]', title, body)
  if (Notification.isSupported()) new Notification({ title, body, icon: join(resources, 'icon.png') }).show()
}

// ------------------------------------------------------------------ 启动
app.on('second-instance', () => openSettings())

/**
 * 旧名称「Lens 截图翻译」的配置搬到新目录。
 * Key 不搬：safeStorage 的密钥存在各自数据目录的 Local State 里，换了目录就解不开，需要重新填写。
 * 格式转换（engine / openaiKey → providers）由 settings.load() 统一处理。
 */
function migrateLegacy() {
  if (AUTOTEST || process.env.LENS_ENGINE_TEST) return
  const dir = app.getPath('userData')
  const legacy = join(app.getPath('appData'), 'Lens 截图翻译', 'settings.json')
  if (existsSync(join(dir, 'settings.json')) || !existsSync(legacy)) return
  try {
    const old = JSON.parse(readFileSync(legacy, 'utf8')) as Record<string, unknown>
    for (const k of ['apiKey', 'openaiKey']) if (String(old[k] ?? '').startsWith('enc:')) old[k] = ''
    // 「Claude 账号」登录已移除（Anthropic 不允许第三方软件使用订阅登录）
    if (old.engine === 'claude-code') delete old.engine
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(old, null, 2))
  } catch (e) {
    logError('migrate', e)
  }
}

app.whenReady().then(async () => {
  migrateLegacy()
  let s = settings.load()
  if (!s.installId) s = settings.update({ installId: `urn:uuid:${randomUUID()}` })
  buildEngine(s)
  void ocr.init()
  syncOverlays()
  screen.on('display-added', syncOverlays)
  screen.on('display-removed', syncOverlays)
  screen.on('display-metrics-changed', syncOverlays)

  tray = new Tray(nativeImage.createFromPath(join(resources, 'tray.png')))
  // 单击截图、双击打开设置：单击要等过双击间隔才动作，否则双击会先触发一次截图
  let clickTimer: NodeJS.Timeout | null = null
  let lastDouble = 0
  tray.on('click', () => {
    if (Date.now() - lastDouble < 600) return
    if (clickTimer) clearTimeout(clickTimer)
    clickTimer = setTimeout(() => {
      clickTimer = null
      void startCapture()
    }, 280)
  })
  tray.on('double-click', () => {
    lastDouble = Date.now()
    if (clickTimer) clearTimeout(clickTimer)
    clickTimer = null
    void hideOverlays(true)
    openSettings()
  })
  updateTray()

  initUpdater({
    enabled: () => settings.get().autoUpdate,
    onChange: (st) => {
      if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('update:state', st)
      updateTray()
      if (st.state === 'ready') {
        notify('新版本已就绪', `v${st.next} 已下载完成，退出时自动安装；也可以在托盘菜单里立即重启更新`)
      }
    }
  })

  const ok = registerHotkey(s.hotkey)
  settings.onChange((next, prev) => {
    if (next.provider !== prev.provider || JSON.stringify(next.providers[next.provider]) !== JSON.stringify(prev.providers[prev.provider])) buildEngine(next)
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

  // LENS_DETECT_TEST=<Key1,Key2…>：只测识别 Key 属于哪家（不打印 Key 本身）
  if (process.env.LENS_DETECT_TEST) {
    for (const k of process.env.LENS_DETECT_TEST.split(',')) console.log('[detect]', k.slice(0, 7) + '…', JSON.stringify(await detectProvider(k)))
    return app.quit()
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
    // LENS_PROVIDER=<服务商> + LENS_PROVIDER_KEY：直接测某家服务；
    // LENS_OPENAI_SOURCE=ccs:<名称> / codex：用本机 Codex / CC Switch 的凭据，按自定义服务测（自测数据目录里没有 Key）；
    // LENS_OPENAI_FAKE=1：本地假服务（只有 Chat Completions），检查接口自动回退
    const fake = process.env.LENS_OPENAI_FAKE ? await fakeModelServer() : null
    const all = process.env.LENS_OPENAI_SOURCE ? findOpenAISources() : []
    const src = all.find((f) => f.id === process.env.LENS_OPENAI_SOURCE)
    if (process.env.LENS_OPENAI_SOURCE && !src) console.log('[engine] sources:', all.map((f) => f.id).join(', '))
    const id = (process.env.LENS_PROVIDER as ProviderId | undefined) ?? (fake || src ? 'custom' : s.provider)
    const conf = fake
      ? { baseUrl: fake.url, key: 'sk-test-0000' }
      : src
        ? { baseUrl: src.baseURL, key: src.apiKey }
        : { key: process.env.LENS_PROVIDER_KEY ?? '', baseUrl: '' }
    const model = process.env.LENS_OPENAI_MODEL ?? s.providers[id]?.model ?? ''
    // 只在内存里拼一份配置（Key 明文，不写盘）：resolveProvider 解密时明文原样返回
    const eng = engineFor({ ...s, provider: id, providers: { ...s.providers, [id]: { ...conf, model } } })
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
        quick: () => startQuick(),
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

