// 在 Windows / Mac 都可运行：加载真实业务模块，仅替换操作系统边界。
// 这些测试验证平台分支和异步流程，不声称验证 macOS 原生 API 的实际行为。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
const plain = (value) => JSON.parse(JSON.stringify(value))
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
function loadTs(file, mocks = {}, globals = {}) {
  const filename = resolve(root, file)
  const { code } = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' })
  const module = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, __dirname: dirname(filename), Buffer, console,
    process: { platform: 'darwin', pid: 42, env: {}, on: noop },
    setTimeout: () => 1, clearTimeout: noop,
    require: (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      if (id.startsWith('node:')) return require(id)
      throw new Error(`Unmocked dependency: ${id}`)
    },
    ...globals
  }, { filename })
  return module.exports
}

function permissionHarness({ status = 'denied', allowRequest = false, canListen = false, platform = 'darwin', broken = false } = {}) {
  const calls = { loads: 0, capture: 0, listen: 0, dialogs: 0, keys: [], opened: [] }
  const module = loadTs('src/main/macos.ts', {
    electron: {
      app: { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: false }) },
      systemPreferences: { getMediaAccessStatus: () => status },
      dialog: { showMessageBox: async () => { calls.dialogs++; return { response: 1 } } },
      shell: { openExternal: async (url) => { calls.opened.push(url) } }
    },
    koffi: { load: () => {
      calls.loads++
      if (broken) throw new Error('framework unavailable')
      return { func: (signature) => {
        if (signature.includes('CGRequestScreenCaptureAccess')) return () => {
          calls.capture++
          if (allowRequest) status = 'granted'
          return allowRequest
        }
        if (signature.includes('CGPreflightListenEventAccess')) return () => canListen
        if (signature.includes('CGRequestListenEventAccess')) return () => { calls.listen++; return false }
        if (signature.includes('CGEventSourceKeyState')) return (source, key) => { calls.keys.push([source, key]); return true }
        throw new Error(signature)
      } }
    } },
    './i18n': { uiLang: () => 'zh-Hans' }
  }, { process: { platform }, console: { error: noop } })
  return { module, calls }
}

test('first-time screen permission reported as denied still requests native access', async () => {
  const { module, calls } = permissionHarness({ allowRequest: true })
  assert.equal(await module.ensureScreenCapture(), true)
  assert.equal(calls.capture, 1)
  assert.equal(calls.dialogs, 0)
})
test('refused permission returns false and explains how to grant access', async () => {
  const { module, calls } = permissionHarness()
  assert.equal(await module.ensureScreenCapture(), false)
  assert.equal(calls.capture, 1)
  assert.equal(calls.dialogs, 1)
})
test('granted screen permission does not request input monitoring or load Quartz', async () => {
  const { module, calls } = permissionHarness({ status: 'granted' })
  assert.equal(await module.ensureScreenCapture(), true)
  assert.equal(calls.loads, 0)
  assert.equal(calls.listen, 0)
})
test('Windows does not load the macOS framework or prompt for Mac permissions', async () => {
  const { module, calls } = permissionHarness({ platform: 'win32' })
  assert.equal(await module.ensureScreenCapture(), true)
  assert.equal(await module.ensureKeyMonitoring(), true)
  assert.equal(module.macSpaceDown(), null)
  assert.equal(calls.loads, 0)
  assert.equal(calls.dialogs, 0)
})
test('space monitoring reads only the hardware Space key after permission is granted', () => {
  const denied = permissionHarness()
  assert.equal(denied.module.macSpaceDown(), null)
  assert.equal(denied.calls.keys.length, 0)
  const allowed = permissionHarness({ canListen: true })
  assert.equal(allowed.module.macSpaceDown(), true)
  assert.deepEqual(allowed.calls.keys, [[1, 49]])
})
test('missing native framework fails closed with permission guidance', async () => {
  const { module, calls } = permissionHarness({ broken: true })
  assert.equal(await module.ensureScreenCapture(), false)
  assert.equal(module.macSpaceDown(), null)
  assert.equal(calls.loads, 1)
})

test('macOS capture matches display IDs, scales Retina windows, and excludes its own windows', async () => {
  const displays = [
    { id: 11, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 2 },
    { id: 22, bounds: { x: -1000, y: 0, width: 1000, height: 800 }, scaleFactor: 1 }
  ]
  const copies = []
  const monitor = (id, x, scale) => ({
    id: () => id, x: () => x, y: () => 0, width: () => 1000, height: () => 800,
    captureImage: async () => ({ width: 1000 * scale, height: 800 * scale, toRaw: async (copy) => { copies.push(copy); return Buffer.alloc(4) } })
  })
  const window = (id, pid) => ({ id: () => id, pid: () => pid, isMinimized: () => false,
    x: () => 50, y: () => 40, width: () => 200, height: () => 100, z: () => id })
  const { captureAll } = loadTs('src/main/capture.ts', {
    electron: { screen: {
      getAllDisplays: () => displays,
      dipToScreenRect: () => assert.fail('Windows-only API called on Mac')
    } },
    'node-screenshots': { Monitor: { all: () => [monitor(22, -1000, 1), monitor(11, 0, 2)] }, Window: { all: () => [window(1, 99), window(2, 42)] } },
    './capture-geometry': loadTs('src/main/capture-geometry.ts')
  })
  const caps = await captureAll()
  assert.deepEqual(plain(caps.map((c) => c.width)), [2000, 1000])
  assert.deepEqual(plain(caps[0].windows), [{ x: 100, y: 80, w: 400, h: 200 }])
  assert.equal(caps[1].windows.length, 0)
  assert.deepEqual(copies, [true, true])
})

function captureHarness(permission, capture) {
  const ipc = new EventEmitter()
  ipc.handle = noop
  const frames = []
  const display = { id: 11, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 1 }
  const cap = { display, width: 1000, height: 800, scale: 1, rgba: Buffer.alloc(4), windows: [] }
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = { send: (channel, value) => { if (channel === 'overlay:frame') frames.push(value) }, on: noop } }
    setAlwaysOnTop() {}
    setMenu() {}
    setBounds() {}
    loadFile() {}
    isVisible() { return false }
  }
  loadTs('src/main/index.ts', {
    electron: {
      app: { isPackaged: false, requestSingleInstanceLock: () => true, on: noop, whenReady: () => new Promise(noop) },
      ipcMain: ipc, nativeTheme: { on: noop }, BrowserWindow: Window,
      screen: { getAllDisplays: () => [display], getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => display }
    },
    '../shared/types': {}, './capture': { captureAll: capture }, './credentials': {}, '../core/detect': {}, '../core/lang': {},
    '../core/platform': { setPlatform: noop }, './ocr': { PaddleOcr: class {} }, './pricing': {}, './updater': {},
    './settings': { settings: { get: () => ({ hotkey: 'Command+Shift+2' }) } },
    './i18n': { t: (key) => key }, '../shared/i18n': {}, '../shared/i18n/mac': {}, './winapi': {}, './secrets': { secretLocked: () => false },
    './macos': { isMac: true, configureMacOverlay: noop, ensureScreenCapture: permission },
    '../core/translator': {}, './chatgpt': {}, './devtest': {}
  })
  return { ipc, frames, cap }
}
test('a screenshot completed after closing the overlay must not reopen it', async () => {
  const pending = deferred()
  const h = captureHarness(async () => true, () => pending.promise)
  h.ipc.emit('capture:start')
  await flush()
  h.ipc.emit('overlay:close')
  pending.resolve([h.cap])
  await flush()
  assert.equal(h.frames.length, 0)
})
test('an old permission denial cannot cancel a newer screenshot session', async () => {
  const permission = deferred(), shot = deferred()
  let requests = 0
  const h = captureHarness(() => ++requests === 1 ? permission.promise : Promise.resolve(true), () => shot.promise)
  h.ipc.emit('capture:start')
  await flush()
  h.ipc.emit('overlay:close')
  h.ipc.emit('capture:start')
  await flush()
  permission.resolve(false)
  await flush()
  shot.resolve([h.cap])
  await flush()
  assert.equal(h.frames.length, 1)
})
test('an old failed capture cannot reset a new capture in progress', async () => {
  const old = deferred(), latest = deferred()
  let requests = 0
  const h = captureHarness(async () => true, () => ++requests === 1 ? old.promise : latest.promise)
  h.ipc.emit('capture:start')
  await flush()
  h.ipc.emit('overlay:close')
  h.ipc.emit('capture:start')
  await flush()
  old.reject(new Error('old capture failed'))
  await flush()
  latest.resolve([h.cap])
  await flush()
  assert.equal(h.frames.length, 1)
})

test('Command shortcuts apply only on Mac; Ctrl stays supported on both platforms', () => {
  const mac = loadTs('src/renderer/src/lib/desktop.ts', {}, { navigator: { platform: 'MacIntel' } })
  const win = loadTs('src/renderer/src/lib/desktop.ts', {}, { navigator: { platform: 'Win32' } })
  assert.equal(mac.primaryModifier({ metaKey: true, ctrlKey: false }), true)
  assert.equal(win.primaryModifier({ metaKey: true, ctrlKey: false }), false)
  assert.equal(mac.primaryModifier({ metaKey: false, ctrlKey: true }), true)
  assert.equal(win.primaryModifier({ metaKey: false, ctrlKey: true }), true)
  assert.equal(mac.shortcutLabel('Ctrl Shift C / Alt C'), 'Cmd Shift C / Option C')
})

test('each platform packages its own OCR runtime and screenshot native dependency', async () => {
  const { doMergeConfigs } = require('app-builder-lib/out/util/config/config.js')
  const config = doMergeConfigs([JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).build])
  const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher.js')
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
  const { DebugLogger } = require('builder-util')
  const debugLogger = new DebugLogger(false)
  await validateConfiguration(config, debugLogger)
  const filter = (platform) => getNodeModuleFileMatcher(root, resolve(root, 'dist'), (s) => s, config[platform], { config, debugLogger }).createFilter()
  const mac = filter('mac'), win = filter('win')
  const file = (filter, path) => filter(resolve(root, 'node_modules', path), { isDirectory: () => false })
  const macOrt = 'onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node'
  const winOrt = 'onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node'
  assert.equal(file(mac, macOrt), true)
  assert.equal(file(mac, winOrt), false)
  assert.equal(file(win, winOrt), true)
  assert.equal(file(win, macOrt), false)
  assert.equal(file(mac, 'node-screenshots-darwin-arm64/node-screenshots.darwin-arm64.node'), true)
  assert.equal(file(mac, '@koromix/koffi-darwin-arm64/koffi.node'), true)
})

test('normalized Windows and Mac package rules exclude development data and old installers', () => {
  const { doMergeConfigs } = require('app-builder-lib/out/util/config/config.js')
  const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher.js')
  const { DebugLogger } = require('builder-util')
  for (const platform of ['win', 'mac']) {
    const config = doMergeConfigs([JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).build])
    const output = resolve(root, 'dist/windows-layout-test')
    const info = { config, projectDir: root, buildResourcesDir: 'build', debugLogger: new DebugLogger(false), isPrepackedAppAsar: false }
    const matchers = getMainFileMatchers(root, output, (s) => s, config[platform], { info }, output, false)
    const filters = matchers.map((m) => m.createFilter())
    const includes = (path) => filters.some((filter) => filter(resolve(root, path), { isDirectory: () => false }))
    for (const path of ['package.json', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/overlay.html', 'out/renderer/assets/desktop.js']) {
      assert.equal(includes(path), true, `${platform}: missing ${path}`)
    }
    for (const path of ['.scratch/debug.log', '.scratch/settings.json', 'android/keystore.properties', 'dist/old-installer.exe', 'src/main/index.ts', 'scripts/check-layout.mjs', 'out/mobile/overlay.html']) {
      assert.equal(includes(path), false, `${platform}: unexpected ${path}`)
    }
  }
})

test('Mac settings links use a fixed allowlist and status checks do not request permissions', async () => {
  const { module, calls } = permissionHarness({ status: 'granted', canListen: true })
  assert.deepEqual(plain(module.macSettingsStatus()), { screen: true, input: true, launchAtLogin: false })
  for (const pane of ['screen', 'input', 'login', 'keyboard', '__proto__', 'https://example.com']) await module.openMacSettings(pane)
  assert.deepEqual(calls.opened, [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
    'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
    'x-apple.systempreferences:com.apple.Keyboard-Settings.extension'
  ])
  assert.equal(calls.capture + calls.listen + calls.dialogs, 0)
})

test('Mac credentials never access Keychain and old encrypted values remain masked', () => {
  const secrets = loadTs('src/main/secrets.ts', { electron: { safeStorage: new Proxy({}, {
    get: () => assert.fail('Mac must not access Keychain')
  }) } })
  assert.equal(secrets.encryptSecret('fixture-key'), 'fixture-key')
  assert.equal(secrets.decryptSecret('fixture-key'), 'fixture-key')
  assert.equal(secrets.maskSecret('fixture-key'), '•••• -key')
  assert.equal(secrets.secretLocked('fixture-key'), false)
  assert.equal(secrets.encryptSecret('enc:ZmFrZQ=='), 'enc:ZmFrZQ==')
  assert.equal(secrets.secretLocked('enc:ZmFrZQ=='), true)
  assert.equal(secrets.decryptSecret('enc:ZmFrZQ=='), '')
  assert.equal(secrets.maskSecret('enc:ZmFrZQ=='), '••••')
})

test('Mac settings save and reload local keys with owner-only permissions, preserving unrelated preferences', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'lava-local-key-'))
  const config = { provider: 'deepseek', hotkey: 'Alt+Space', providers: { deepseek: { key: 'enc:ZmFrZQ==', baseUrl: '', model: 'fixture' } } }
  const filename = resolve(dir, 'settings.json')
  writeFileSync(filename, JSON.stringify(config), { mode: 0o644 })
  const secrets = loadTs('src/main/secrets.ts', { electron: { safeStorage: new Proxy({}, {
    get: () => assert.fail('Mac settings must not access Keychain')
  }) } })
  const load = () => loadTs('src/main/settings.ts', {
    electron: { app: { getPath: () => dir } },
    '../shared/types': { DEFAULT_SETTINGS: config }, './secrets': secrets
  }).settings
  try {
    const settings = load()
    settings.load()
    assert.equal(statSync(filename).mode & 0o777, 0o600)
    settings.update({ providers: { deepseek: { key: '••••', model: 'new-model' } } })
    assert.equal(settings.get().providers.deepseek.key, config.providers.deepseek.key)
    // Even a pre-existing temporary file with broad permissions must be tightened.
    writeFileSync(filename + '.tmp', '', { mode: 0o644 })
    chmodSync(filename + '.tmp', 0o644)
    settings.update({ providers: { deepseek: { key: 'new-fixture-key' } } })
    assert.equal(statSync(filename).mode & 0o777, 0o600)
    const reopened = load()
    reopened.load()
    assert.equal(reopened.get().providers.deepseek.key, 'new-fixture-key')
    assert.equal(reopened.get().providers.deepseek.model, 'new-model')
    assert.equal(reopened.get().hotkey, 'Alt+Space')
    assert.equal(reopened.public().providers.deepseek.key, '•••• -key')
    reopened.update({ providers: { deepseek: { key: '' } } })
    const cleared = load()
    cleared.load()
    assert.equal(cleared.get().providers.deepseek.key, '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Windows credential storage retains its existing encryption behavior', () => {
  const secrets = loadTs('src/main/secrets.ts', { electron: { safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString()
  } } }, { process: { platform: 'win32' } })
  const stored = secrets.encryptSecret('fixture-key')
  assert.match(stored, /^enc:/)
  assert.equal(secrets.decryptSecret(stored), 'fixture-key')
  assert.equal(secrets.secretLocked(stored), false)
})
