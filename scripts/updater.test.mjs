import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
const require = createRequire(import.meta.url)
const code = transformSync(readFileSync(new URL('../src/main/updater.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code
function harness({ platform = 'darwin', packaged = true, mode = 'installer', exists = true } = {}) {
  const updater = new EventEmitter(), timers = new Map(), shown = [], changes = []
  let nextTimer = 0, calls = 0, quits = 0, enabled = true, failure
  updater.checkForUpdates = async () => { calls++; if (failure) throw failure }
  updater.quitAndInstall = () => quits++
  const mocks = {
    electron: { app: { isPackaged: packaged, getVersion: () => '1.4.8', getAppPath: () => '/app' }, shell: { showItemInFolder: file => shown.push(file) } },
    'electron-updater': { autoUpdater: updater },
    'node:fs': { existsSync: () => exists, readFileSync: () => JSON.stringify({ macUpdateMode: mode }) },
    './i18n': { t: key => key, uiLang: () => 'en' },
    '../shared/mac-update': { macUpdateText: (_lang, key) => `mac:${key}` }
  }
  const module = { exports: {} }
  runInNewContext(code, { module, require: id => id in mocks ? mocks[id] : require(id), process: { platform }, Error,
    setTimeout: f => { timers.set(++nextTimer, f); return nextTimer }, clearTimeout: id => timers.delete(id),
    setInterval: f => { timers.set(++nextTimer, f); return nextTimer }, clearInterval: id => timers.delete(id) })
  const api = module.exports
  api.initUpdater({ enabled: () => enabled, onChange: s => changes.push(s) })
  return { api, updater, timers, shown, changes, calls: () => calls, quits: () => quits,
    fail: error => { failure = error }, enabled: on => { enabled = on; api.setAutoUpdate(on) } }
}
test('Mac checks and downloads; manual packages never invoke native installation', async () => {
  const h = harness()
  assert.equal(h.updater.autoDownload, true)
  assert.equal(h.updater.autoInstallOnAppQuit, false)
  await h.api.check(); assert.equal(h.calls(), 1)
  h.updater.emit('update-downloaded', { version: '1.4.9', downloadedFile: '/cache/update.zip' })
  assert.equal((await h.api.check()).manualInstall, true)
  assert.equal(h.calls(), 1)
  h.api.installNow()
  assert.deepEqual(h.shown, ['/cache/update.zip'])
  assert.equal(h.quits(), 0)
})
test('signed Mac build opts into native installation', () => {
  const h = harness({ mode: 'native' })
  assert.equal(h.updater.autoInstallOnAppQuit, true)
  h.updater.emit('update-downloaded', { version: '1.4.9', downloadedFile: '/cache/update.zip' })
  assert.equal(h.api.updateState().manualInstall, false)
  h.api.installNow(); assert.equal(h.quits(), 1)
})
test('Windows retains native automatic installation', () => {
  const h = harness({ platform: 'win32' })
  assert.equal(h.updater.autoInstallOnAppQuit, true)
  h.updater.emit('update-downloaded', { version: '1.4.9', downloadedFile: '/cache/update.exe' })
  h.api.installNow(); assert.equal(h.quits(), 1)
  assert.equal(h.shown.length, 0)
})
test('development runs remain disabled', async () => {
  const h = harness({ packaged: false })
  assert.equal((await h.api.check()).state, 'disabled')
  assert.equal(h.calls(), 0)
  assert.equal(h.timers.size, 0)
})
test('missing Mac manifest is an error, not a false up-to-date result', async () => {
  const h = harness(); h.fail(new Error('404 latest-mac.yml'))
  const state = await h.api.check()
  assert.equal(state.state, 'error'); assert.equal(state.message, 'mac:missing')
})
test('turning off automatic updates cancels startup and periodic checks', async () => {
  const h = harness()
  assert.equal(h.timers.size, 2)
  h.enabled(false); assert.equal(h.timers.size, 0)
  await h.api.check(); assert.equal(h.calls(), 1, 'manual check still works')
  h.enabled(true); h.enabled(true); assert.equal(h.timers.size, 2, 'only one timer per purpose')
})
test('a removed cached installer remains recoverable without quitting', () => {
  const h = harness({ exists: false })
  h.updater.emit('update-downloaded', { version: '1.4.9', downloadedFile: '/cache/missing.zip' })
  h.api.installNow()
  assert.equal(h.api.updateState().state, 'error')
  assert.equal(h.quits(), 0); assert.equal(h.shown.length, 0)
})
