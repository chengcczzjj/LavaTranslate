import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const noop = () => {}
const flush = () => new Promise(setImmediate)

function loadTs(file, mocks = {}, globals = {}) {
  const filename = resolve(root, file)
  const { code } = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' })
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, __dirname: dirname(filename), Buffer, console,
    Atomics, Int32Array, SharedArrayBuffer,
    process: { platform: 'win32', pid: 42, env: {}, on: noop },
    setTimeout, clearTimeout, setInterval, clearInterval,
    require: (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      if (id.startsWith('node:')) return require(id)
      throw new Error(`Unmocked dependency: ${id}`)
    },
    ...globals
  }, { filename })
  return module.exports
}

test('promoteOverlay restores minimized windows, cycles topmost, and still re-asserts topmost when foreground activation fails', () => {
  const log = []
  let iconic = 1
  let exStyle = 0x00000008 // WS_EX_TOPMOST already set (Win11 demoted state)
  let attachAllowed = 1
  const native = {
    GetAsyncKeyState: () => 0,
    GetForegroundWindow: () => 999,
    GetWindowThreadProcessId: () => 222,
    AttachThreadInput: (from, to, attach) => { log.push(['attach', from, to, attach]); return attachAllowed },
    SetForegroundWindow: (hwnd) => { log.push(['fg', hwnd]); return attachAllowed },
    BringWindowToTop: (hwnd) => { log.push(['bringTop', hwnd]); return 1 },
    SetWindowPos: (hwnd, after, _x, _y, _w, _h, flags) => {
      log.push(['swp', hwnd, after, flags])
      if (after === -2) exStyle &= ~0x00000008
      if (after === -1) exStyle |= 0x00000008
      return 1
    },
    ShowWindow: (hwnd, cmd) => { log.push(['showWindow', hwnd, cmd]); iconic = 0; return 1 },
    IsIconic: () => iconic,
    GetWindowLongW: () => exStyle,
    WindowFromPoint: () => 777,
    GetAncestor: () => 777,
    GetCurrentThreadId: () => 111
  }
  const koffi = { load: () => ({ func: (sig) => native[sig.match(/__stdcall (\w+)\(/)[1]] }) }
  const winapi = loadTs('src/main/winapi.ts', { koffi })

  winapi.promoteOverlay(500, true)
  assert.deepEqual(log, [
    ['showWindow', 500, 9],
    ['swp', 500, -2, 0x0053],
    ['swp', 500, -1, 0x0053],
    ['attach', 111, 222, 1],
    ['bringTop', 500],
    ['fg', 500],
    ['attach', 111, 222, 0],
    ['swp', 500, -1, 0x0053]
  ])

  // Secondary display: promote without stealing foreground.
  log.length = 0
  winapi.promoteOverlay(501, false)
  assert.deepEqual(log, [
    ['swp', 501, -2, 0x0053],
    ['swp', 501, -1, 0x0053]
  ])

  // Elevated foreground window blocks AttachThreadInput: topmost is still re-asserted.
  log.length = 0
  attachAllowed = 0
  exStyle = 0 // Windows stripped WS_EX_TOPMOST
  winapi.promoteOverlay(500, true)
  assert.deepEqual(log, [
    ['swp', 500, -2, 0x0053],
    ['swp', 500, -1, 0x0053],
    ['attach', 111, 222, 1],
    ['bringTop', 500],
    ['fg', 500],
    ['swp', 500, -1, 0x0053]
  ])

  // focusWindowAt must not call BringWindowToTop on underlying windows during Space passthrough.
  log.length = 0
  attachAllowed = 1
  winapi.focusWindowAt(10, 20, [500])
  assert.equal(log.some((c) => c[0] === 'bringTop'), false)
  assert.ok(log.some((c) => c[0] === 'fg' && c[1] === 777))
})

function overlayHarness() {
  const ipc = new EventEmitter()
  ipc.handle = noop
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    setAppUserModelId: noop,
    commandLine: { appendSwitch: noop },
    getPath: () => '/tmp',
    getVersion: () => '1.4.11',
    getPreferredSystemLanguages: () => ['zh-CN'],
    whenReady: () => Promise.resolve(),
    isReady: () => true,
    quit: noop
  })
  const powerMonitor = new EventEmitter()
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 }, workArea: { x: 1920, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }
  ]
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => displays[0]
  })
  const events = []
  const errors = []
  const createdWindows = []
  let nextId = 100
  class FakeWindow extends EventEmitter {
    constructor(opts) {
      super()
      this.id = ++nextId
      this.bounds = { x: opts.x ?? 0, y: opts.y ?? 0, width: opts.width ?? 100, height: opts.height ?? 100 }
      this.visible = false
      this.opacity = 1
      this.destroyed = false
      this.crashed = false
      this.minimized = false
      this.focused = false
      this.sent = []
      const wc = Object.assign(new EventEmitter(), {
        id: this.id,
        send: (channel, payload) => {
          this.sent.push([channel, payload])
          events.push(['send', this.id, channel])
        },
        focus: () => { this.focused = true; events.push(['wcFocus', this.id]) },
        isCrashed: () => this.crashed,
        isDestroyed: () => this.destroyed
      })
      this.webContents = wc
      createdWindows.push(this)
    }
    setAlwaysOnTop(flag, level) { events.push(['aot', this.id, flag, level, this.visible]) }
    setMenu() {}
    setBounds(b) { this.bounds = b; events.push(['bounds', this.id]) }
    getBounds() { return this.bounds }
    setOpacity(v) { this.opacity = v; events.push(['opacity', this.id, v]) }
    getOpacity() { return this.opacity }
    setIgnoreMouseEvents(v) { events.push(['ignoreMouse', this.id, v]) }
    show() { this.visible = true; events.push(['show', this.id]) }
    showInactive() { this.visible = true; events.push(['showInactive', this.id]) }
    hide() { this.visible = false; events.push(['hide', this.id]) }
    focus() { this.focused = true; events.push(['focus', this.id]) }
    isVisible() { return this.visible }
    isFocused() { return this.focused }
    isMinimized() { return this.minimized }
    restore() { this.minimized = false; events.push(['restore', this.id]) }
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true; this.visible = false; events.push(['destroy', this.id]); this.emit('closed') }
    loadFile() {}
    loadURL() {}
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeUInt32LE(this.id, 0); return b }
  }
  const winSpaceCalls = []
  class FakeWinSpace {
    constructor() { this.scrollHeld = false }
    async start(_onPress, _onScroll, onExpired) { this.onExpired = onExpired; return true }
    async setMode(mode) { winSpaceCalls.push(['mode', mode]); return true }
    async setCaptureSpace(on, lease) { winSpaceCalls.push(['capture', on, lease]); return true }
    stop() { winSpaceCalls.push(['stop']) }
  }
  const winapiCalls = []
  const captureAll = async () => displays.map((display) => ({
    display, width: 1920, height: 1080, scale: 1, rgba: Buffer.alloc(4), windows: []
  }))
  const mod = loadTs('src/main/index.ts', {
    electron: {
      app, ipcMain: ipc, powerMonitor, screen,
      BrowserWindow: FakeWindow,
      Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} },
      Menu: { buildFromTemplate: () => ({}), setApplicationMenu: noop },
      nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
      nativeTheme: { on: noop, shouldUseDarkColors: false },
      Notification: { isSupported: () => false },
      globalShortcut: { register: () => true, unregister: noop, unregisterAll: noop, isRegistered: () => false },
      session: { defaultSession: { preconnect: noop } },
      net: { fetch: async () => ({}) },
      clipboard: {}, ClipboardItem: class {}, dialog: {}, shell: {}
    },
    '../shared/types': { LANGUAGES: [{ code: 'zh-Hans', name: '简体中文', native: '简体中文' }], providerInfo: () => ({ id: 'gemini', api: 'chat' }) },
    './capture': { captureAll, cropRgba: noop, rgbaToBgra: noop },
    './credentials': { chatgptSession: () => null, findOpenAISources: () => [], resolveProvider: () => null },
    '../core/detect': { detectProvider: noop },
    '../core/lang': { langFor: noop },
    '../core/platform': { setPlatform: noop },
    './ocr': { PaddleOcr: class {} },
    './ocr-language': { matchesTargetLanguage: async () => false },
    './pricing': { refreshPrices: noop, sortByPrice: () => [] },
    './updater': { check: noop, initUpdater: noop, installNow: noop, setAutoUpdate: noop, updateState: () => ({ state: 'idle', version: '1.4.11' }) },
    './settings': { settings: { load: () => ({ hotkey: 'Super+Space', firstRunDone: true, installId: 'id', providers: {}, provider: 'gemini', targetLang: 'zh-Hans', autoTranslate: true, displayMode: 'overlay', replyAssist: true, replyTone: 'auto' }), get: () => ({ hotkey: 'Super+Space', providers: {}, provider: 'gemini', targetLang: 'zh-Hans', autoTranslate: true, displayMode: 'overlay', replyAssist: true, replyTone: 'auto' }), update: () => ({}), public: () => ({}), onChange: noop } },
    './offline-survey': { submitOfflineVote: noop },
    './secrets': { secretLocked: () => false },
    './i18n': { errorText: String, t: (k) => k, uiLang: () => 'zh-Hans' },
    '../shared/i18n': { langBase: (s) => s, providerName: (s) => s, UI_LANGS: [] },
    './winapi': {
      focusWindowAt: noop,
      hwndOf: (b) => b.readUInt32LE(0),
      keyDown: () => false,
      VK_SPACE: 0x20,
      isTopmost: () => true,
      promoteOverlay: (hwnd, active) => { winapiCalls.push(['promote', hwnd, active]); events.push(['promote', hwnd, active]) },
      ensureTopmost: (hwnd, reset) => { winapiCalls.push(['ensureTopmost', hwnd, reset]); events.push(['ensureTopmost', hwnd, reset]) }
    },
    './macos': { configureMacOverlay: noop, ensureKeyMonitoring: async () => true, ensureScreenCapture: async () => true, isMac: false, macSpaceDown: () => null, macSettingsStatus: () => null, openMacSettings: noop },
    '../shared/hotkeys': { acceleratorLabel: (v) => v },
    '../shared/pin': loadTs('src/shared/pin.ts'),
    '../shared/mac-update': { macUpdateText: () => '' },
    './win-space': { WinSpaceHotkey: FakeWinSpace },
    '../core/translator': { OpenAIEngine: class {}, TranslateError: Error },
    './chatgpt': { cancelSignIn: noop, listPlanModels: noop, refresh: noop, SignInExpired: Error, signIn: noop },
    './devtest': { fakeModelServer: noop, FixtureEngine: class {}, MockEngine: class {}, runAutotest: noop, runEngineTest: noop, runI18nShots: noop, runPassTest: noop, runReview: noop, runSignInTest: noop },
    './diagnostics': { logError: (kind, detail) => { errors.push([kind, detail]); return null } }
  })
  return { mod, ipc, app, powerMonitor, createdWindows, events, errors, winapiCalls, winSpaceCalls }
}

test('Windows overlays promote after show/showInactive, self-heal after renderer/GPU crash, fall back from opacity=0, and refresh on resume', async () => {
  const h = overlayHarness()
  await h.mod.startup
  assert.equal(h.createdWindows.length, 2)
  const [w1, w2] = h.createdWindows

  // Mark initial overlays ready via overlay:ready IPC.
  h.ipc.emit('overlay:ready', { sender: w1.webContents })
  h.ipc.emit('overlay:ready', { sender: w2.webContents })

  // 1. Capture + frame-ready promotes both active and secondary monitors AFTER show/showInactive.
  h.events.length = 0
  h.ipc.emit('capture:start')
  await flush()
  await flush()
  assert.ok(w1.sent.some(([c]) => c === 'overlay:frame'))
  assert.ok(w2.sent.some(([c]) => c === 'overlay:frame'))

  w1.minimized = true
  h.ipc.emit('overlay:frame-ready', { sender: w1.webContents })
  h.ipc.emit('overlay:frame-ready', { sender: w2.webContents })
  const showIdx1 = h.events.findIndex((e) => e[0] === 'show' && e[1] === w1.id)
  const promoteIdx1 = h.events.findIndex((e) => e[0] === 'promote' && e[1] === w1.id && e[2] === true)
  const showIdx2 = h.events.findIndex((e) => e[0] === 'showInactive' && e[1] === w2.id)
  const promoteIdx2 = h.events.findIndex((e) => e[0] === 'promote' && e[1] === w2.id && e[2] === false)
  assert.ok(showIdx1 >= 0 && promoteIdx1 > showIdx1, 'active overlay must promote after show()')
  assert.ok(showIdx2 >= 0 && promoteIdx2 > showIdx2, 'secondary overlay must promote after showInactive()')
  assert.equal(w1.minimized, false, 'minimized overlay must be restored before show')
  assert.equal(w1.opacity, 0, 'starts at opacity 0 awaiting visible')

  // 2. If renderer never sends overlay:visible (stalled rAF), main fallback timer restores opacity=1 and ensures topmost.
  await new Promise((r) => setTimeout(r, 230))
  assert.equal(w1.opacity, 1, 'fallback timer must restore opacity on primary')
  assert.equal(w2.opacity, 1, 'fallback timer must restore opacity on secondary')
  assert.ok(h.winapiCalls.some((c) => c[0] === 'ensureTopmost' && c[1] === w1.id))
  assert.ok(h.errors.some(([kind]) => kind === 'overlay reveal fallback'))

  // 3. Renderer crash destroys and immediately recreates the overlay.
  w1.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  await flush()
  assert.equal(w1.destroyed, true, 'crashed overlay must be destroyed')
  assert.equal(h.createdWindows.length, 3, 'replacement overlay must be created')
  const w1New = h.createdWindows[2]

  // 4. Next capture waits for replacement overlay readiness before sending overlay:frame.
  h.ipc.emit('capture:start')
  await flush()
  await flush()
  assert.equal(w1New.sent.some(([c]) => c === 'overlay:frame'), false, 'must wait until new overlay is ready')
  h.ipc.emit('overlay:ready', { sender: w1New.webContents })
  await flush()
  await flush()
  assert.equal(w1New.sent.some(([c]) => c === 'overlay:frame'), true, 'frame delivered once new overlay signals ready')

  // 5. Closing before show() still resets renderer state so background heartbeats do not leak.
  h.ipc.emit('overlay:close')
  await flush()
  assert.equal(w1New.sent.some(([c]) => c === 'overlay:reset'), true, 'hidden overlay still receives overlay:reset')

  // 6. GPU process crash rebuilds all Windows overlays.
  h.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
  await flush()
  await flush()
  assert.equal(w1New.destroyed, true)
  assert.equal(w2.destroyed, true)
  assert.equal(h.createdWindows.length, 5)

  // 7. System resume uninstalls and reinstalls Win+Space hook cleanly and rebuilds overlays.
  h.winSpaceCalls.length = 0
  h.powerMonitor.emit('resume')
  await flush()
  await flush()
  const modes = h.winSpaceCalls.filter((c) => c[0] === 'mode').map((c) => c[1])
  assert.deepEqual(modes, [0, 1], 'resume must cycle mode 0 -> 1 to refresh OS hook')
  assert.equal(h.createdWindows.length, 7, 'resume rebuilds pre-warmed overlays')
})

test('WinSpaceHotkey respawns an unexpectedly exited worker, but stays stopped after stop()', async () => {
  let spawns = 0
  const workers = []
  class FakeWorker extends EventEmitter {
    constructor(script, opts) {
      super()
      spawns++
      this.state = new Int32Array(opts.workerData)
      workers.push(this)
      setImmediate(() => this.emit('message', 'ready'))
    }
    unref() {}
  }
  const koffi = {
    load: () => ({
      func: () => () => {
        const w = workers.at(-1)
        if (w) setImmediate(() => w.emit('message', { revision: Atomics.load(w.state, 7), ok: true }))
        return 1
      }
    })
  }
  const { WinSpaceHotkey } = loadTs('src/main/win-space.ts', {
    'node:worker_threads': { Worker: FakeWorker },
    koffi,
    './win-space-state': loadTs('src/main/win-space-state.ts')
  })

  const hk = new WinSpaceHotkey()
  let expired = 0
  assert.equal(await hk.start(noop, noop, () => expired++), true)
  assert.equal(spawns, 1)

  // Simulate unexpected worker exit while resident in background.
  workers[0].emit('exit', 1)
  assert.equal(expired, 1)

  // Subsequent setMode(1) automatically respawns the worker and succeeds.
  Atomics.store(workers[0].state, 1, 1)
  const respawnPromise = hk.setMode(1)
  await flush()
  Atomics.store(workers[1].state, 1, 2)
  workers[1].emit('message', { revision: 1, ok: true })
  assert.equal(await respawnPromise, true)
  assert.equal(spawns, 2)

  // Explicit stop() prevents respawning.
  hk.stop()
  assert.equal(await hk.setMode(1), false)
  assert.equal(spawns, 2)
})
