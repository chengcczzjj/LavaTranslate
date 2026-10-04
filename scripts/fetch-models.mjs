// 下载 PP-OCRv6 (small) ONNX 模型到 resources/models，并给识别模型追加 GPU 端 ArgMax（需要 python + onnx）
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'models')
const BASE = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master'

const files = [
  ['det.onnx', `${BASE}/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx`, 9929594],
  ['rec_raw.onnx', `${BASE}/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx`, 21234383],
  ['rec_dict.txt', `${BASE}/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt`, 74947]
]

mkdirSync(outDir, { recursive: true })
if (existsSync(join(outDir, 'rec.onnx')) && existsSync(join(outDir, 'det.onnx'))) {
  console.log('✓ 模型已就绪')
  process.exit(0)
}
for (const [name, url, size] of files) {
  const dest = join(outDir, name)
  if (existsSync(dest) && statSync(dest).size === size) continue
  process.stdout.write(`↓ ${name} ... `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  const got = statSync(dest).size
  if (got !== size) throw new Error(`${name} 大小不符: ${got} != ${size}`)
  console.log(`${(got / 1048576).toFixed(1)} MB`)
}
const raw = join(outDir, 'rec_raw.onnx')
const rec = join(outDir, 'rec.onnx')
try {
  execFileSync('python', [join(root, 'scripts', 'patch-rec.py'), raw, rec], { stdio: 'inherit' })
  unlinkSync(raw)
} catch {
  console.warn('! 未能给识别模型追加 ArgMax（需要 pip install onnx），使用原始模型，速度稍慢')
  renameSync(raw, rec)
}
