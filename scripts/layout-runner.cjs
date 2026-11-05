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
    // 等待真实组件淡入，再保存可目视复查的回归图。
    win.setContentSize(1160, await win.webContents.executeJavaScript('document.documentElement.scrollHeight'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    writeFileSync(join(output, 'regression.png'), (await win.webContents.capturePage()).toPNG())
    console.log('Regression image: ' + join(output, 'regression.png'))
    for (const platform of ['Win32', 'MacIntel']) {
      await win.loadFile(join(output, 'settings.html'))
      const hotkey = await win.webContents.executeJavaScript(`window.checkSettingsHotkey(${JSON.stringify(platform)}).then(passed => ({ passed }), error => ({ error: error.stack || String(error) }))`)
      if (hotkey.error) throw new Error(hotkey.error)
      result.passed.push(hotkey.passed)
    }
    console.log(JSON.stringify(result, null, 2))
    writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2))
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
