// Native Mac integration test: real ZIP download/checksum; no installation or external traffic.
const assert = require('node:assert/strict')
const { app, autoUpdater: nativeUpdater } = require('electron')
const { createServer } = require('node:http')
const { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { join, basename } = require('node:path')
const { tmpdir } = require('node:os')
const { load, dump } = require('js-yaml')

const dir = mkdtempSync(join(tmpdir(), 'lava-mac-update-'))
app.setPath('userData', dir)
app.getVersion = () => '1.0.0' // Simulate an older app; the downloaded ZIP is the actual build.
let server, updater
const timeout = setTimeout(() => { console.error('[mac-update] timed out'); app.exit(1) }, 120000)
app.whenReady().then(async () => {
  assert.equal(process.platform, 'darwin')
  const dist = join(__dirname, '../dist')
  const manifest = load(readFileSync(join(dist, 'latest-mac.yml'), 'utf8'))
  const zip = manifest.files.find(f => f.url.endsWith('-arm64.zip'))
  assert.ok(zip, 'actual arm64 ZIP must be in the update manifest')
  const zipPath = join(dist, basename(zip.url))
  let zipRequests = 0, nativeCalls = 0
  nativeUpdater.checkForUpdates = () => { nativeCalls++; throw Error('Unsigned build must not invoke Squirrel installation') }
  const onlyZip = dump({ ...manifest, files: [zip], path: zip.url, sha512: zip.sha512 })
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/latest-mac.yml') { res.end(onlyZip); return }
    if (decodeURIComponent(path) === '/' + basename(zip.url)) {
      zipRequests++; res.writeHead(200, { 'Content-Length': statSync(zipPath).size })
      createReadStream(zipPath).pipe(res); return
    }
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { MacUpdater } = require('electron-updater')
  updater = new MacUpdater({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}` })
  updater.forceDevUpdateConfig = true
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = false
  updater.disableDifferentialDownload = true
  const config = join(dir, 'dev-app-update.yml')
  writeFileSync(config, dump({ provider: 'generic', url: `http://127.0.0.1:${server.address().port}`, updaterCacheDirName: basename(dir) }))
  updater.updateConfigPath = config
  let downloaded
  updater.on('update-downloaded', info => { downloaded = info.downloadedFile })
  const result = await updater.checkForUpdates()
  assert.ok(result.downloadPromise, 'update must download automatically')
  await result.downloadPromise
  assert.equal(zipRequests, 1)
  assert.ok(downloaded && existsSync(downloaded))
  assert.equal(statSync(downloaded).size, statSync(zipPath).size)
  assert.equal(nativeCalls, 0)
  console.log('[mac-update] PASS: native Electron downloaded and verified the actual Mac ZIP; manual mode never invoked Squirrel installation')
  updater.closeServerIfExists()
  server.close()
  clearTimeout(timeout)
  app.exit(0)
}).catch(error => { console.error('[mac-update] FAIL', error); app.exit(1) })
