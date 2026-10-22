// 苹果芯片 Mac 本机打包。Windows 上可以构建前端/主进程，但不能替代 macOS 原生验证。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arch = process.argv[2] ?? 'arm64'
if (process.platform !== 'darwin') {
  console.error('请在 Mac 上运行此命令。Windows 上可运行 npm run typecheck、npm run build、npm run export:mac，再把源码包带到 Mac 调试。')
  process.exit(1)
}
if (arch !== 'arm64' || process.arch !== 'arm64') {
  console.error('当前 Mac 预览版面向 Apple Silicon。请使用原生 arm64 Node.js，避免通过 Rosetta 运行；此打包入口尚未适配 Intel Mac。')
  process.exit(1)
}
for (const name of ['det.onnx', 'rec.onnx', 'rec_dict.txt']) {
  if (!existsSync(join(root, 'resources/models', name))) {
    console.error(`缺少 OCR 模型 ${name}；请先运行 npm run models。`)
    process.exit(1)
  }
}
const ort = join(root, 'node_modules/onnxruntime-node/bin')
if (!existsSync(ort) || !readdirSync(ort).some((n) => existsSync(join(ort, n, 'darwin', arch, 'onnxruntime_binding.node')))) {
  console.error('未找到 macOS arm64 OCR 库。请在 Mac 项目目录重新运行 npm ci，不要复制 Windows 的 node_modules。')
  process.exit(1)
}
function run(script, args = [], env = {}) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root, stdio: 'inherit', env: { ...process.env, ...env }
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run('node_modules/electron-vite/bin/electron-vite.js', ['build'])
// 本地预览使用 ad-hoc 签名，无需 Apple 开发者证书；不能作为已公证的正式发布包。
run('node_modules/electron-builder/cli.js', [
  '--mac', '--arm64', '--publish', 'never',
  '--config.mac.identity=-', '--config.mac.hardenedRuntime=false', '--config.mac.notarize=false',
  ...(process.argv.includes('--dir') ? ['--dir'] : [])
], { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
