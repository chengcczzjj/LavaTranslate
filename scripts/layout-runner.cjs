const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const output = process.argv[2]
app.setPath('userData', join(output, 'profile'))
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1160, height: 1040,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true }
  })
  try {
    await win.loadFile(join(output, 'index.html'))
    const result = await win.webContents.executeJavaScript('(() => { try { return window.runLayoutTests() } catch (error) { return { error: error.stack || String(error) } } })()')
    if (result.error) throw new Error(result.error)
    console.log(JSON.stringify(result, null, 2))
    // 等待真实组件淡入，再保存可目视复查的回归图。
    await new Promise((resolve) => setTimeout(resolve, 700))
    writeFileSync(join(output, 'regression.png'), (await win.webContents.capturePage()).toPNG())
    console.log('Regression image: ' + join(output, 'regression.png'))
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
