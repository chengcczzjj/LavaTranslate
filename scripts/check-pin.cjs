// Run after npm run build. Real renderer/preload IPC and native window bounds;
// hidden windows, synthetic OCR/translation, isolated profile, no API calls.
const { spawn } = require('node:child_process')
if (!process.versions.electron) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true })
  child.on('error', (error) => { console.error(error); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
  return
}

const assert = require('node:assert/strict')
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { transformSync } = require('esbuild')
const root = join(__dirname, '..')
const output = join(root, '.scratch/pin-check')
mkdirSync(output, { recursive: true })
app.setPath('userData', join(output, 'profile'))
app.disableHardwareAcceleration()
const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
async function wait(check, label) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await pause() }
  throw new Error('Timed out: ' + label)
}
const js = (win, code) => win.webContents.executeJavaScript(code)
const event = (win, selector, name, options = {}) => js(win,
  `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new ${name === 'wheel' ? 'WheelEvent' : 'MouseEvent'}(${JSON.stringify(name)}, ${JSON.stringify({ bubbles: true, ...options })}))`)
const timeout = setTimeout(() => { console.error('Pin check timed out'); app.exit(1) }, 30000)

app.whenReady().then(async () => {
  ipcMain.on('ui:lang', (e) => { e.returnValue = 'zh-Hans' })
  const preload = join(root, 'out/preload/index.js')
  // Execute the production pin section directly; only app integration and window
  // visibility are substituted. IPC handlers, resizing, dragging and renderer stay real.
  const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  const section = main.match(/\/\/ -+ 钉图窗口([\s\S]*?)\/\/ -+ 设置窗口/)
  assert.ok(section, 'production pin section must be found')
  const constants = readFileSync(join(root, 'src/shared/pin.ts'), 'utf8').replace(/export /g, '')
  const code = transformSync(constants + section[1] + '\nreturn pins', { loader: 'ts' }).code
  class HiddenWindow extends BrowserWindow {
    constructor(options) {
      super({ ...options, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } })
    }
    showInactive() {}
  }
  let cursorWindow = null
  const testScreen = new Proxy(screen, { get(target, key) {
    if (key !== 'getCursorScreenPoint') return Reflect.get(target, key)
    return () => {
      if (!cursorWindow || cursorWindow.isDestroyed()) return screen.getCursorScreenPoint()
      const b = cursorWindow.getBounds()
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
    }
  } })
  const pins = new Function('BrowserWindow', 'ipcMain', 'screen', 'preload', 'loadPage', 'overlayOf', 'configureMacOverlay', 'hideOverlays', 'appIcon', 'isMac', code)(
    HiddenWindow, ipcMain, testScreen, preload,
    (win, page) => win.loadFile(join(root, `out/renderer/${page}.html`)),
    () => null, () => {}, () => {}, undefined, false
  )
  const overlay = new HiddenWindow({ show: false, width: 900, height: 650, webPreferences: { preload, sandbox: false } })
  let requestId = 0
  let autoTranslate = true
  let failSave = false
  const requests = []
  ipcMain.handle('settings:set', (e, patch) => {
    if (failSave) throw new Error('simulated settings write failure')
    if (patch.autoTranslate !== undefined) autoTranslate = patch.autoTranslate
    e.sender.send('settings:changed', { autoTranslate })
    return { autoTranslate }
  })
  const line = { id: 1, text: 'Original text', score: 1, box: { x: 20, y: 20, w: 150, h: 22 } }
  const block = { key: '1', lineIds: [1], source: line.text, translation: '翻译后的文字', role: 'ui' }
  const emit = (event) => overlay.webContents.send('translate:event', { requestId, event })
  ipcMain.on('translate:start', (_e, request) => {
    requests.push(request)
    requestId = request.requestId
    emit({ type: 'ocr', lines: [line], ms: 1 })
    emit(!autoTranslate && !request.manual ? { type: 'recognized', reason: 'ocr-only' } : { type: 'translating' })
  })
  await overlay.loadFile(join(root, 'out/renderer/overlay.html'))
  const pixels = new Uint8Array(900 * 650 * 4).fill(245)
  for (let n = 3; n < pixels.length; n += 4) pixels[n] = 255
  // A color stripe makes it obvious that the thumbnail contains the source image.
  for (let y = 120; y < 165; y++) for (let x = 70; x < 360; x++) {
    const n = (y * 900 + x) * 4
    pixels[n] = 255; pixels[n + 1] = 110; pixels[n + 2] = 50
  }
  overlay.webContents.send('overlay:frame', {
    displayId: screen.getPrimaryDisplay().id, width: 900, height: 650, scale: 1, pixels,
    cursor: null, windows: [], targetLang: 'zh-Hans', autoTranslate: true, displayMode: 'overlay',
    hotkey: 'Super+Space', replyAssist: false, replyTone: 'auto', quick: false, refresh: false
  })
  overlay.webContents.send('overlay:shown')
  await pause(100)
  overlay.webContents.sendInputEvent({ type: 'mouseDown', x: 50, y: 50, button: 'left', clickCount: 1 })
  overlay.webContents.sendInputEvent({ type: 'mouseMove', x: 450, y: 250, movementX: 400, movementY: 200 })
  overlay.webContents.sendInputEvent({ type: 'mouseUp', x: 450, y: 250, button: 'left', clickCount: 1 })
  await wait(() => js(overlay, `!!document.querySelector('.toolbar')`), 'selection toolbar')

  const clickPin = async (altKey = false) => {
    const before = new Set(pins.keys())
    await js(overlay, `document.querySelector('.toolbar .lucide-pin').closest('button').dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: ${altKey} }))`)
    await wait(() => [...pins.keys()].some((id) => !before.has(id)), 'pin creation')
    const pin = [...pins.values()].find((p) => !before.has(p.win.webContents.id))
    await wait(() => js(pin.win, `!!document.querySelector('.pin-card')`), 'pin content')
    await pause(700)
    return pin
  }
  const dimensions = async (win) => js(win, `(() => {
    const r = document.querySelector('.pin-card').getBoundingClientRect()
    return { width: Math.round(r.width), height: Math.round(r.height) }
  })()`)
  const close = async (pin) => {
    await event(pin.win, '.pin-card', 'contextmenu', { button: 2 })
    await wait(() => pin.win.isDestroyed(), 'right-click close')
  }

  // Pin before any translation exists while Alt is held, then release Alt.
  await js(overlay, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true }))`)
  await wait(() => js(overlay, `!!document.querySelector('.alt-chip')`), 'Alt original view')
  const original = await clickPin(true)
  assert.equal(original.payload.original, true)
  assert.deepEqual(original.payload.blocks, [])
  await js(overlay, `window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }))`)
  assert.equal(await js(original.win, `!!document.querySelector('.tl-layer')`), false)
  await event(original.win, '.pin-card', 'dblclick')
  await wait(() => !!original.expandedSize, 'original compact')
  await close(original)

  emit({ type: 'block', block })
  emit({ type: 'done', ms: 1, engine: 'test' })
  await wait(() => js(overlay, `!!document.querySelector('[data-block]')`), 'translated overlay')
  // A quick Alt-click must pin the original even before the delayed Alt view starts.
  const quickOriginal = await clickPin(true)
  assert.equal(quickOriginal.payload.original, true)
  assert.equal(await js(quickOriginal.win, `!!document.querySelector('.tl-layer')`), false)
  await close(quickOriginal)

  const translated = await clickPin()
  const win = translated.win
  // A real wheel event has its cursor over the pin. Synthetic DOM events must
  // supply that position too, independent of the user's cursor / monitor DPI.
  cursorWindow = win
  assert.equal(translated.payload.original, false)
  assert.equal(await js(win, `!!document.querySelector('[data-block]')`), true)
  await event(win, '.pin-card', 'wheel', { deltaY: -120 })
  await wait(() => win.getBounds().width > 436, 'wheel zoom')
  const expanded = win.getBounds()
  const cardSize = await dimensions(win)
  await event(win, '.pin-card', 'dblclick')
  await wait(() => Math.abs(win.getBounds().width - 92) <= 1, 'native compact window').catch(async (error) => {
    throw new Error(`${error.message}: ${JSON.stringify(win.getBounds())}, card ${JSON.stringify(await dimensions(win))}`)
  })
  assert.equal(win.isDestroyed(), false, 'double-click must keep the pin alive')
  assert.ok(Math.abs(win.getBounds().height - 92) <= 1, 'native compact height allows DIP rounding')
  assert.deepEqual(await dimensions(win), { width: 56, height: 56 })
  assert.equal(await js(win, `!!document.querySelector('[data-block]')`), true, 'thumbnail retains translation')
  await event(win, '.pin-card', 'wheel', { deltaY: -120 })
  await pause()
  assert.ok(Math.abs(win.getBounds().width - 92) <= 1, 'compact square ignores wheel zoom')
  writeFileSync(join(output, 'compact.png'), (await win.webContents.capturePage()).toPNG())
  const area = screen.getDisplayMatching(expanded).workArea
  win.setPosition(area.x + area.width - 100, area.y + area.height - 100)
  await event(win, '.pin-card', 'dblclick')
  await wait(() => win.getBounds().width === expanded.width, 'native restored window')
  const restored = win.getBounds()
  assert.equal(restored.height, expanded.height)
  assert.deepEqual(await dimensions(win), cardSize, 'restore prior wheel zoom')
  assert.ok(restored.x + restored.width <= area.x + area.width + 1, 'restore stays on screen horizontally')
  assert.ok(restored.y + restored.height <= area.y + area.height + 1, 'restore stays on screen vertically')
  await pause(350)
  writeFileSync(join(output, 'restored.png'), (await win.webContents.capturePage()).toPNG())
  await close(translated)
  assert.equal(pins.size, 0, 'all closed pins are released')

  const controls = await js(overlay, `[...document.querySelectorAll('.toolbar .tb-btn')].map(el => el.className)`)
  assert.ok(controls[0].includes('tb-translate') && controls[1].includes('tb-reply') && controls[2].includes('tb-compare'), 'primary order is translate, reply, compare')
  assert.ok(controls.at(-2).includes('tb-help') && controls.at(-1).includes('tb-close'), 'help immediately precedes close')
  assert.equal(await js(overlay, `!!document.querySelector('.toolbar .lucide-eye, .tb-seg')`), false, 'eye and segmented controls removed')
  const compare = () => js(overlay, `document.querySelector('.tb-compare').getAttribute('aria-pressed') === 'true'`)
  await js(overlay, `document.querySelector('.tb-compare').click()`)
  await wait(compare, 'comparison enabled')
  await wait(() => js(overlay, `!!document.querySelector('.side-panel')`), 'comparison pane shown')
  await js(overlay, `document.querySelector('.tb-compare').click()`)
  await wait(async () => !await compare(), 'comparison disabled')
  await js(overlay, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))`)
  await wait(compare, 'Tab updates comparison selection')
  await js(overlay, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))`)
  await wait(async () => !await compare(), 'Tab restores overlay')
  await js(overlay, `document.querySelector('.tb-reply').click()`)
  await wait(() => js(overlay, `document.querySelector('.tb-reply').getAttribute('aria-pressed') === 'true' && !!document.querySelector('.reply')`), 'reply opens from reordered button')
  await js(overlay, `document.querySelector('.tb-reply').click()`)
  await wait(() => js(overlay, `document.querySelector('.tb-reply').getAttribute('aria-pressed') === 'false'`), 'reply closes')
  await event(overlay, '.tb-help-anchor', 'mouseover')
  await wait(() => js(overlay, `!!document.querySelector('.tb-shortcuts')`), 'shortcut tooltip')
  assert.equal(await js(overlay, `(() => {
    const el = document.querySelector('.tb-shortcuts'), r = el.getBoundingClientRect()
    return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
      && el.textContent.includes('Ctrl R') && el.textContent.includes('按住 Alt') && el.textContent.includes('F3')
  })()`), true, 'shortcut content fits small viewport')
  await js(overlay, `document.querySelector('.tb-help-anchor').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.querySelector('.tb-shortcuts') }))`)
  await event(overlay, '.tb-shortcuts', 'mouseover')
  await pause(200)
  assert.equal(await js(overlay, `!!document.querySelector('.tb-shortcuts')`), true, 'help remains open while reading/scrolling')
  overlay.setContentSize(900, 900)
  await wait(() => js(overlay, `document.querySelector('.tb-shortcuts').scrollHeight <= document.querySelector('.tb-shortcuts').clientHeight + 1`), 'full shortcut list on taller screen')
  const helpRect = await js(overlay, `(() => {
    const a = document.querySelector('.toolbar').getBoundingClientRect(), b = document.querySelector('.tb-shortcuts').getBoundingClientRect()
    const x = Math.max(0, Math.floor(Math.min(a.left, b.left)) - 8), y = Math.max(0, Math.floor(Math.min(a.top, b.top)) - 8)
    return { x, y, width: Math.ceil(Math.max(a.right, b.right)) - x + 8, height: Math.ceil(Math.max(a.bottom, b.bottom)) - y + 8 }
  })()`)
  writeFileSync(join(output, 'toolbar-help.png'), (await overlay.webContents.capturePage(helpRect)).toPNG())
  await event(overlay, '.tb-shortcuts', 'mouseout')
  await wait(() => js(overlay, `!document.querySelector('.tb-shortcuts')`), 'help dismissed on leave')

  // The compact language control and automatic translation use the real Overlay,
  // toolbar and preload, with settings/translation services replaced above.
  const checked = () => js(overlay, `document.querySelector('.tb-auto input').checked`)
  const toggle = () => js(overlay, `document.querySelector('.tb-auto input').click()`)
  assert.equal(await js(overlay, `document.querySelector('.tb-lang').textContent`), '简体中文')
  assert.equal(await js(overlay, `!!document.querySelector('.tb-src, .tb-arrow')`), false)
  assert.equal(await checked(), true, 'initial checkbox uses capture settings')
  await toggle()
  await wait(async () => !autoTranslate && !await checked() && await js(overlay, `!!document.querySelector('button[aria-label="翻译"]')`), 'turn off automatic translation')
  assert.equal(requests.at(-1).reuseOcr, true, 'toggle reuses OCR')
  assert.equal(!!requests.at(-1).manual, false, 'automatic requests respect saved setting')
  await wait(() => js(overlay, `!document.querySelector('[data-block]')`), 'off shows original only')
  await js(overlay, `document.querySelector('button[aria-label="翻译"]').click()`)
  await wait(() => requests.at(-1).manual === true, 'manual translation while auto is off')
  emit({ type: 'block', block })
  emit({ type: 'done', ms: 1, engine: 'test' })
  assert.equal(await checked(), false, 'manual translate does not change saved preference')
  await toggle()
  await wait(async () => autoTranslate && await checked() && !requests.at(-1).manual, 'turn automatic translation back on')
  emit({ type: 'recognized', reason: 'same-language' })
  await pause(300)
  assert.equal(await js(overlay, `document.querySelector('.tb-lang').textContent`), '简体中文', 'same-language status does not lengthen the language button')
  await event(overlay, '.tb-auto', 'mouseover')
  await wait(() => js(overlay, `[...document.querySelectorAll('.tip')].some(el => el.textContent === '自动翻译')`), 'auto translate hover tip')
  await pause(200)
  const toolbarRect = await js(overlay, `(() => { const r = document.querySelector('.toolbar').getBoundingClientRect(); return { x: Math.floor(r.x) - 8, y: Math.floor(r.y) - 8, width: Math.ceil(r.width) + 16, height: 105 } })()`)
  writeFileSync(join(output, 'toolbar.png'), (await overlay.webContents.capturePage(toolbarRect)).toPNG())
  autoTranslate = false
  overlay.webContents.send('settings:changed', { autoTranslate })
  await wait(async () => !await checked(), 'external settings change synchronizes checkbox')
  const count = requests.length
  failSave = true
  await toggle()
  await wait(() => js(overlay, `document.body.textContent.includes('自动翻译设置保存失败')`), 'save failure feedback')
  assert.equal(await checked(), false, 'failed save leaves checkbox unchanged')
  assert.equal(requests.length, count, 'failed save does not restart translation')
  overlay.destroy()
  clearTimeout(timeout)
  console.log('Passed: Alt original pin during/after translation, quick Alt-click, translated thumbnail, native collapse/restore, zoom preservation, edge positioning, right-click close.')
  console.log('Passed: target-only language control, automatic translation toggle/synchronization, OCR reuse, manual override, tooltip and failed-save recovery.')
  console.log('Passed: primary button order, compare click/Tab state, reply toggle, help placement, hover retention and shortcut contents.')
  app.exit(0)
}).catch((error) => { console.error(error); clearTimeout(timeout); app.exit(1) })
