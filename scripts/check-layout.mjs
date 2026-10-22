// 使用 Electron 自带 Chromium 的真实 Canvas 字体测量和共享 React 组件；无需 API Key 或模型请求。
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, '.scratch/layout-check')
await mkdir(output, { recursive: true })
await build({
  absWorkingDir: root, entryPoints: ['scripts/layout.test.tsx'], bundle: true,
  outfile: resolve(output, 'tests.js'), platform: 'browser', format: 'iife',
  jsx: 'automatic', tsconfig: 'tsconfig.web.json', define: { 'process.env.NODE_ENV': '"production"' }
})
await writeFile(resolve(output, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="tests.css"><body><script src="tests.js"></script></body>')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(createRequire(import.meta.url)('electron'), [resolve(root, 'scripts/layout-runner.cjs'), output], {
  cwd: root, env, stdio: 'inherit', windowsHide: true
})
const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; console.error('Layout check timed out') }, 60000)
child.on('error', (error) => { clearTimeout(timeout); console.error(error); process.exitCode = 1 })
child.on('exit', (code) => { clearTimeout(timeout); process.exitCode = code ?? 1 })
