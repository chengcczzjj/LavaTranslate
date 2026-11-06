import assert from 'node:assert/strict'
import { test } from 'node:test'
import { load } from 'js-yaml'
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider.js'
import { pinMacManifest } from './retain-platform-update.mjs'

test('Windows-only releases keep Mac assets resolvable by the actual update provider', async () => {
  const source = 'version: 1.4.9\nfiles:\n  - url: LavaTranslate-Mac-1.4.9-arm64.zip\n    sha512: test\npath: LavaTranslate-Mac-1.4.9-arm64.zip\n'
  const once = pinMacManifest(source, 'chengcczzjj/LavaTranslate', 'v1.4.9')
  const twice = pinMacManifest(once, 'chengcczzjj/LavaTranslate', 'v1.4.10')
  assert.equal(load(twice).files[0].url, 'https://github.com/chengcczzjj/LavaTranslate/releases/download/v1.4.9/LavaTranslate-Mac-1.4.9-arm64.zip')
  assert.equal(load(twice).path, load(twice).files[0].url)
  assert.equal(load(twice).version, '1.4.9')
  const requests = []
  const base = 'https://github.com/chengcczzjj/LavaTranslate/releases/latest/download/'
  const provider = new GenericProvider({ provider: 'generic', url: base }, { isAddNoCacheQuery: false }, {
    platform: 'darwin', executor: { request: async options => { requests.push(options.path); return twice } }
  })
  assert.equal(provider.resolveFiles(load(source))[0].url.href, base + 'LavaTranslate-Mac-1.4.9-arm64.zip')
  const retained = await provider.getLatestVersion()
  assert.deepEqual(requests, ['/chengcczzjj/LavaTranslate/releases/latest/download/latest-mac.yml'])
  assert.equal(provider.resolveFiles(retained)[0].url.href, load(twice).files[0].url)
})
test('retained feeds reject unrelated download destinations', () => {
  assert.throws(() => pinMacManifest('version: 1\nfiles: []', 'chengcczzjj/LavaTranslate', 'v1'))
  assert.throws(() => pinMacManifest('version: "1"\nfiles:\n  - url: https://example.test/app.zip', 'chengcczzjj/LavaTranslate', 'v1'))
})
