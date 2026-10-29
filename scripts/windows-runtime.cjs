// App-local VC++ runtime: no UAC prompt or network access on the user's PC.
// Only extract Microsoft's pinned redistributable; never copy DLLs from System32.
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { Arch } = require('builder-util')
const manifest = require('../build/windows-runtime.json')
const cache = resolve(__dirname, '../build/windows-runtime', manifest.version)
const runtimeDir = join(cache, 'x64')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase()

function verifyRuntime(dir) {
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = join(dir, name)
    const bytes = readFileSync(file)
    if (hash(bytes) !== expected) throw new Error(`VC++ runtime checksum mismatch: ${file}`)
    const pe = bytes.readUInt32LE(0x3c)
    if (bytes.readUInt32LE(pe) !== 0x00004550 || bytes.readUInt16LE(pe + 4) !== 0x8664) {
      throw new Error(`VC++ runtime is not Windows x64: ${file}`)
    }
  }
}

async function prepareRuntime() {
  if (Object.keys(manifest.files).every((name) => existsSync(join(runtimeDir, name)))) {
    verifyRuntime(runtimeDir)
    return runtimeDir
  }
  if (process.platform !== 'win32') throw new Error('Prepare the VC++ runtime on Windows with npm run runtime:win first.')
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, 'vc_redist.x64.exe')
  let bytes
  if (process.env.LAVA_VC_REDIST_EXE) bytes = readFileSync(process.env.LAVA_VC_REDIST_EXE)
  else if (existsSync(archive)) bytes = readFileSync(archive)
  else {
    console.log(`[runtime] Downloading Microsoft VC++ ${manifest.version} x64`)
    const response = await fetch(manifest.url, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`VC++ runtime download failed: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  // Verify before extracting anything. Offline builds may supply this exact EXE.
  if (hash(bytes) !== manifest.sha256) throw new Error('VC++ redistributable checksum mismatch; refusing to package it.')
  writeFileSync(archive, bytes)
  const work = mkdtempSync(join(cache, 'extract-'))
  const extracted = []
  const expand = (cab, dest) => {
    mkdirSync(dest, { recursive: true })
    execFileSync('expand.exe', ['-F:*', cab, dest], { windowsHide: true, stdio: 'pipe', timeout: 60_000 })
    return readdirSync(dest).map((name) => join(dest, name))
  }
  try {
    // WiX Burn bundles contain CAB containers. Extract those, then their payload CABs.
    // No installer is executed and no system runtime/registry is changed.
    let cursor = 0, count = 0
    while ((cursor = bytes.indexOf('MSCF', cursor, 'ascii')) !== -1) {
      const pos = cursor
      cursor += 4
      if (pos + 36 > bytes.length || bytes.readUInt32LE(pos + 4) !== 0) continue
      const size = bytes.readUInt32LE(pos + 8)
      if (size < 36 || pos + size > bytes.length || bytes[pos + 24] !== 3 || bytes[pos + 25] !== 1) continue
      const cab = join(work, `container-${count}.cab`)
      writeFileSync(cab, bytes.subarray(pos, pos + size))
      const files = expand(cab, join(work, `container-${count++}`))
      for (const file of files) {
        if (readFileSync(file).subarray(0, 4).toString() === 'MSCF') extracted.push(...expand(file, `${file}-files`))
      }
      cursor = pos + size
    }
    // Validate a complete staging directory before it becomes the reusable cache.
    const staging = join(work, 'x64')
    mkdirSync(staging)
    for (const name of Object.keys(manifest.files)) {
      const source = extracted.find((file) => file.endsWith(`${name}_amd64`))
      if (!source) throw new Error(`VC++ redistributable is missing ${name}`)
      copyFileSync(source, join(staging, name))
    }
    verifyRuntime(staging)
    mkdirSync(runtimeDir, { recursive: true })
    for (const name of Object.keys(manifest.files)) copyFileSync(join(staging, name), join(runtimeDir, name))
  } finally {
    // work comes from mkdtemp inside this project's ignored runtime cache.
    if (resolve(work).startsWith(`${cache}${require('node:path').sep}extract-`)) rmSync(work, { recursive: true, force: true })
  }
  return runtimeDir
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  if (context.arch !== Arch.x64) throw new Error('The bundled VC++ runtime currently supports only Windows x64.')
  const source = await prepareRuntime()
  const bin = join(context.appOutDir, 'resources/app.asar.unpacked/node_modules/onnxruntime-node/bin')
  const nativeDirs = readdirSync(bin).filter((name) => name.startsWith('napi-v'))
    .map((name) => join(bin, name, 'win32/x64'))
    .filter((dir) => existsSync(join(dir, 'onnxruntime_binding.node')))
  if (!nativeDirs.length) throw new Error('Packaged ONNX Runtime x64 binding is missing; refusing to build the installer.')
  // Node uses an altered DLL search path when loading .node files. The EXE
  // directory alone is insufficient: ORT's dependencies must also sit by its DLL.
  for (const destination of [context.appOutDir, ...nativeDirs]) {
    for (const name of Object.keys(manifest.files)) copyFileSync(join(source, name), join(destination, name))
    verifyRuntime(destination)
  }
  console.log(`[runtime] Bundled ${Object.keys(manifest.files).length} Microsoft VC++ ${manifest.version} x64 DLLs`)
}

module.exports = afterPack
module.exports.verifyRuntime = verifyRuntime
if (require.main === module) prepareRuntime().then((dir) => console.log(`[runtime] Ready: ${dir}`)).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
