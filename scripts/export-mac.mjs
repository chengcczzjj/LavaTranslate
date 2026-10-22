// 只导出开发所需源码和模型，不包含 Windows 依赖、安卓签名、本机设置或 Git 历史。
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip' // 由项目已有的 onnxruntime-node 依赖提供

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const zip = new AdmZip()
const prefix = `LavaTranslate-Mac-${version}`
let count = 0
function add(relative) {
  const path = join(root, relative)
  if (!existsSync(path)) throw new Error(`缺少导出文件：${relative}`)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`不导出符号链接：${relative}`)
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name.startsWith('.') || ['node_modules', '__pycache__'].includes(name)) continue
      add(`${relative}/${name}`)
    }
  } else {
    zip.addFile(`${prefix}/${relative}`, readFileSync(path))
    count++
  }
}
for (const file of [
  'package.json', 'package-lock.json', 'electron.vite.config.ts', 'vite.mobile.config.ts',
  'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'LICENSE', 'README.md', 'README.zh-CN.md', '.gitignore',
  'src', 'scripts', 'docs', 'build/icon-1024.png', 'build/icon.ico',
  'resources/icon.png', 'resources/icon.ico', 'resources/tray.png', 'resources/tray@1.25x.png',
  'resources/tray@1.5x.png', 'resources/tray@2x.png', 'resources/model-prices.json', 'resources/test.png'
]) add(file)
// 已下载的模型直接带走，Mac 首次运行不必再次下载。
for (const name of ['det.onnx', 'rec.onnx', 'rec_dict.txt']) {
  const path = `resources/models/${name}`
  if (existsSync(join(root, path))) add(path)
}
mkdirSync(join(root, 'dist'), { recursive: true })
const output = join(root, 'dist', `LavaTranslate-Mac-Source-${version}.zip`)
zip.writeZip(output)
console.log(`已导出 ${count} 个文件：${output}\n这是供 Mac 调试的源码包，不是 .app / .dmg 安装包。先阅读 docs/MACOS.md。`)
