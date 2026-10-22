// 在真实 Electron / macOS 进程中验证原生依赖和本地 OCR，不申请权限、不调用翻译服务。
// node_modules/.bin/electron scripts/check-mac.cjs
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInThisContext } = require('node:vm')
const { app, nativeImage, screen, systemPreferences } = require('electron')
const { transformSync } = require('esbuild')

const root = join(__dirname, '..')
app.setPath('userData', join(app.getPath('temp'), 'lavatrans-mac-native-check'))

app.whenReady().then(async () => {
  assert.equal(process.platform, 'darwin', '此检查需要在 Mac 上运行')
  assert.equal(process.arch, 'arm64', '当前 Mac 预览版需要 arm64 Electron')
  const { Monitor } = require('node-screenshots')
  const monitors = Monitor.all()
  const displays = screen.getAllDisplays()
  assert.ok(displays.length > 0, '没有连接的显示器')
  for (const display of displays) {
    assert.ok(monitors.some((m) => m.id() === display.id), `原生截图库缺少显示器 ${display.id}`)
  }
  const cg = require('koffi').load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
  const canListen = cg.func('bool CGPreflightListenEventAccess()')
  // 仅解析函数，避免在自动检查中弹出授权或读取按键。
  cg.func('bool CGEventSourceKeyState(int stateID, uint16_t key)')
  cg.func('bool CGRequestScreenCaptureAccess()')
  console.log('[mac] native dependencies OK', JSON.stringify({
    electron: process.versions.electron,
    arch: process.arch,
    displays: displays.map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor })),
    screenPermission: systemPreferences.getMediaAccessStatus('screen'),
    inputMonitoring: canListen()
  }))

  const { code } = transformSync(readFileSync(join(root, 'src/main/ocr.ts'), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node22'
  })
  const mod = { exports: {} }
  // ONNX Runtime 会检查 TypedArray 的构造函数，必须与原生库处在同一个 JS realm。
  runInThisContext(`(function(require, module, exports) { ${code}\n})`, { filename: 'ocr.ts' })(require, mod, mod.exports)
  const ocr = new mod.exports.PaddleOcr(join(root, 'resources/models'))
  const image = nativeImage.createFromPath(join(root, 'resources/test.png'))
  assert.ok(!image.isEmpty(), '缺少 OCR 测试图片')
  const { width, height } = image.getSize()
  const bgra = image.toBitmap()
  const data = new Uint8Array(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    data[i] = bgra[i + 2]
    data[i + 1] = bgra[i + 1]
    data[i + 2] = bgra[i]
    data[i + 3] = bgra[i + 3]
  }
  const lines = await ocr.recognize({ data, width, height })
  assert.equal(ocr.provider, 'cpu')
  assert.match(lines.map((line) => line.text).join(' '), /Good morning/i)
  for (const { box } of lines) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0)
    assert.ok(box.x + box.w <= width && box.y + box.h <= height)
  }
  console.log('[mac] real OCR OK', JSON.stringify({ provider: ocr.provider, lines, timing: ocr.timing }))
  app.exit(0)
}).catch((error) => {
  console.error('[mac] native check failed', error)
  app.exit(1)
})
