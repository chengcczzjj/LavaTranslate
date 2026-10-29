import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(root, '.scratch')
mkdirSync(scratch, { recursive: true })
const afterPack = require('./windows-runtime.cjs')

function harness(t, loadApp, { blockedData = false, env = {} } = {}) {
  const dir = mkdtempSync(join(scratch, 'startup-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const userData = join(dir, 'profile')
  if (blockedData) writeFileSync(userData, 'not a directory')
  const paths = { userData, temp: join(dir, 'temp') }
  const calls = { dialogs: [], exits: [] }
  const processMock = Object.assign(new EventEmitter(), {
    platform: 'win32', arch: 'x64', versions: { electron: 'test-electron' }, env
  })
  const electron = {
    app: {
      getPath: (key) => paths[key], setPath: (key, value) => { paths[key] = value },
      getVersion: () => 'test-version', exit: (code) => calls.exits.push(code)
    },
    dialog: { showErrorBox: (title, message) => calls.dialogs.push({ title, message }) }
  }
  const load = (name, mocks) => {
    const filename = join(root, 'src/main', name)
    const { code } = transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' })
    const module = { exports: {} }
    runInNewContext(code, {
      module, exports: module.exports, process: processMock, Error,
      console: { error() {} },
      require: (id) => {
        if (id === 'electron') return electron
        if (Object.hasOwn(mocks, id)) return mocks[id]()
        if (id.startsWith('node:')) return require(id)
        throw new Error(`Unexpected dependency: ${id}`)
      }
    }, { filename })
    return module.exports
  }
  const diagnostics = load('diagnostics.ts', {})
  load('bootstrap.ts', { './diagnostics': () => diagnostics, './app.js': () => loadApp(processMock, paths) })
  return { calls, paths, processMock }
}

test('a native DLL import failure is logged and shown before app initialization', (t) => {
  const h = harness(t, (proc) => {
    assert.equal(proc.listenerCount('uncaughtException'), 1)
    assert.equal(proc.listenerCount('unhandledRejection'), 1)
    throw Object.assign(new Error('Cannot load onnxruntime_binding.node: DLL missing'), { code: 'ERR_DLOPEN_FAILED' })
  })
  assert.deepEqual(h.calls.exits, [1])
  assert.equal(h.calls.dialogs.length, 1)
  const log = readFileSync(join(h.paths.userData, 'error.log'), 'utf8')
  assert.match(log, /startup: LavaTranslate test-version; win32 .* x64; Electron test-electron/)
  assert.match(log, /DLL missing/)
  assert.ok(h.calls.dialogs[0].message.includes(join(h.paths.userData, 'error.log')))
  assert.match(h.calls.dialogs[0].message, /vc_redist\.x64\.exe/)
})

test('an asynchronous startup failure also reports the error and exits', async (t) => {
  const h = harness(t, () => ({ startup: Promise.reject(new Error('settings folder is read-only')) }))
  await new Promise(setImmediate)
  assert.deepEqual(h.calls.exits, [1])
  assert.match(h.calls.dialogs[0].message, /settings folder is read-only/)
  assert.doesNotMatch(h.calls.dialogs[0].message, /vc_redist/)
})

test('startup logging falls back to temp if the profile cannot be written', (t) => {
  const h = harness(t, () => { throw new Error('startup failure') }, { blockedData: true })
  const file = join(h.paths.temp, 'LavaTranslate-error.log')
  assert.match(readFileSync(file, 'utf8'), /startup failure/)
  assert.ok(h.calls.dialogs[0].message.includes(file))
  assert.deepEqual(h.calls.exits, [1])
})

test('successful startup stays silent and later errors go to the isolated test profile', async (t) => {
  const h = harness(t, (_proc, paths) => {
    assert.equal(paths.userData, join(paths.temp, 'lens-autotest'))
    return { startup: Promise.resolve() }
  }, { env: { LENS_AUTOTEST: '1' } })
  await new Promise(setImmediate)
  h.processMock.emit('uncaughtException', new Error('later failure'))
  assert.deepEqual(h.calls.dialogs, [])
  assert.deepEqual(h.calls.exits, [])
  assert.match(readFileSync(join(h.paths.userData, 'error.log'), 'utf8'), /uncaughtException: Error: later failure/)
})

test('runtime packaging skips macOS and rejects unimplemented Windows architectures', async () => {
  await afterPack({ electronPlatformName: 'darwin', arch: 3 })
  await assert.rejects(afterPack({ electronPlatformName: 'win32', arch: 3 }), /only Windows x64/)
})

test('missing or modified runtime files fail validation instead of being shipped', (t) => {
  const dir = mkdtempSync(join(scratch, 'runtime-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.throws(() => afterPack.verifyRuntime(dir), /ENOENT/)
  writeFileSync(join(dir, 'concrt140.dll'), 'corrupt DLL')
  assert.throws(() => afterPack.verifyRuntime(dir), /checksum mismatch/)
})
