// 用 Electron（Chromium）把 SVG 渲染成 PNG：npx electron scripts/icons/render.cjs <jobs.json>
// jobs.json：[{ "svg": "a.svg", "out": "a-256.png", "size": 256 }, ...]
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const jobs = JSON.parse(readFileSync(process.argv[process.argv.length - 1], 'utf8'))
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="margin:0;background:transparent;overflow:hidden"><img id="i" style="display:block"></body></html>'))
  for (const j of jobs) {
    const src = 'data:image/svg+xml;base64,' + readFileSync(j.svg).toString('base64')
    await win.webContents.executeJavaScript(`new Promise((r) => { const i = document.getElementById('i'); i.onload = () => requestAnimationFrame(() => requestAnimationFrame(r)); i.width = ${j.size}; i.height = ${j.size}; i.src = ${JSON.stringify(src)} })`)
    await new Promise((r) => setTimeout(r, 80))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: j.size, height: j.size })
    writeFileSync(j.out, img.resize({ width: j.size, height: j.size }).toPNG())
  }
  app.quit()
})
