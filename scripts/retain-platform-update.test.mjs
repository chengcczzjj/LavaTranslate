import assert from 'node:assert/strict'
import { test } from 'node:test'
import { load } from 'js-yaml'
import { pinMacManifest } from './retain-platform-update.mjs'

test('Windows-only releases pin retained Mac files to their original release', () => {
  const source = 'version: 1.4.9\nfiles:\n  - url: LavaTranslate-Mac-1.4.9-arm64.zip\n    sha512: test\npath: LavaTranslate-Mac-1.4.9-arm64.zip\n'
  const once = pinMacManifest(source, 'chengcczzjj/LavaTranslate', 'v1.4.9')
  const twice = pinMacManifest(once, 'chengcczzjj/LavaTranslate', 'v1.4.10')
  assert.equal(load(twice).files[0].url, 'https://github.com/chengcczzjj/LavaTranslate/releases/download/v1.4.9/LavaTranslate-Mac-1.4.9-arm64.zip')
  assert.equal(load(twice).path, load(twice).files[0].url)
  assert.equal(load(twice).version, '1.4.9')
})
test('retained feeds reject unrelated download destinations', () => {
  assert.throws(() => pinMacManifest('version: 1\nfiles: []', 'chengcczzjj/LavaTranslate', 'v1'))
  assert.throws(() => pinMacManifest('version: "1"\nfiles:\n  - url: https://example.test/app.zip', 'chengcczzjj/LavaTranslate', 'v1'))
})
