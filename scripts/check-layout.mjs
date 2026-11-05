// 使用 Electron 自带 Chromium 的真实 Canvas 字体测量和共享 React 组件；无需 API Key 或模型请求。
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, '.scratch/layout-check')
await mkdir(output, { recursive: true })
await rm(resolve(output, 'result.json'), { force: true })
await build({
  absWorkingDir: root, entryPoints: ['scripts/layout.test.tsx'], bundle: true,
  outfile: resolve(output, 'tests.js'), platform: 'browser', format: 'iife',
  jsx: 'automatic', tsconfig: 'tsconfig.web.json', define: { 'process.env.NODE_ENV': '"production"' }
})
await writeFile(resolve(output, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="tests.css"><body><script src="tests.js"></script></body>')
await build({
  absWorkingDir: root, entryPoints: ['scripts/settings-hotkey.test.tsx'], bundle: true,
  outfile: resolve(output, 'settings.js'), platform: 'browser', format: 'iife',
  jsx: 'automatic', tsconfig: 'tsconfig.web.json', define: { 'process.env.NODE_ENV': '"production"' }
})
await writeFile(resolve(output, 'settings.html'), '<!doctype html><meta charset="utf-8"><body><script src="settings.js"></script></body>')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(createRequire(import.meta.url)('electron'), [resolve(root, 'scripts/layout-runner.cjs'), output], {
  cwd: root, env, stdio: 'inherit', windowsHide: true
})
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; console.error('Layout check timed out') }, 60000)
child.on('error', (error) => { clearTimeout(timeout); console.error(error); process.exitCode = 1 })
child.on('exit', async (code) => {
  clearTimeout(timeout)
  process.exitCode = code ?? 1
  if (code === 0) {
    try { if (JSON.parse(await readFile(resolve(output, 'result.json'), 'utf8')).status !== 'passed') throw new Error('No passing result') }
    catch (error) { console.error('Chromium did not complete layout checks:', error.message); process.exitCode = 1 }
  }
})
