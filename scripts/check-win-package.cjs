// Run against a built Windows directory, using its own Electron and native modules.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join, resolve, toNamespacedPath } = require('node:path')

async function probe(root) {
  const r = createRequire(join(root, 'resources/app.asar/package.json'))
  const ort = r('onnxruntime-node')
  r('node-screenshots')
  const kernel = r('koffi').load('kernel32.dll')
  const handle = kernel.func('void * __stdcall GetModuleHandleW(str16 name)')
  const fileName = kernel.func('uint32_t __stdcall GetModuleFileNameW(void *module, void *buffer, uint32_t size)')
  const bin = join(root, 'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin')
  const nativeDirs = readdirSync(bin).filter((name) => name.startsWith('napi-v')).map((name) => join(bin, name, 'win32/x64'))
  const normalize = (file) => toNamespacedPath(resolve(file)).toLowerCase()
  for (const name of ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
    const module = handle(name)
    assert.ok(module, `not loaded: ${name}`)
    const buffer = Buffer.alloc(65536)
    const len = fileName(module, buffer, buffer.length / 2)
    assert.ok(len > 0 && len < buffer.length / 2, `cannot resolve loaded DLL: ${name}`)
    const file = buffer.subarray(0, len * 2).toString('utf16le')
    assert.ok([root, ...nativeDirs].some((dir) => normalize(file) === normalize(join(dir, name))), `using external runtime: ${file}`)
    console.log(`[package] ${name}: bundled runtime loaded`)
  }
  for (const [name, dims] of [['det', [1, 3, 64, 64]], ['rec', [1, 3, 48, 320]]]) {
    const session = await ort.InferenceSession.create(join(root, 'resources/models', `${name}.onnx`), { executionProviders: ['cpu'] })
    try {
      const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(dims.reduce((a, b) => a * b)), dims) })
      assert.ok(Object.keys(result).length > 0)
      console.log(`[package] ${name}: CPU inference OK`)
    } finally { await session.release() }
  }
  console.log('[package] Native modules and app-local VC++ runtime OK')
}

module.exports = { probe }
if (require.main === module) {
  assert.equal(process.platform, 'win32', 'This check requires Windows.')
  const root = resolve(process.argv[2] ?? 'dist/win-unpacked')
  require('./windows-runtime.cjs').verifyRuntime(root)
  const code = `require(${JSON.stringify(__filename)}).probe(${JSON.stringify(root)}).catch(e => { console.error(e); process.exitCode = 1 })`
  const result = spawnSync(join(root, 'LavaTranslate.exe'), ['-e', code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000, windowsHide: true
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) console.error(result.error)
  process.exitCode = result.status ?? 1
}
