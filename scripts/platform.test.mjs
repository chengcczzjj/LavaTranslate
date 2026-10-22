import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'

const source = readFileSync(new URL('../src/main/capture-geometry.ts', import.meta.url), 'utf8')
const js = stripTypeScriptTypes(source)
const { windowOnCapture } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('Windows physical coordinates stay unchanged at 150% desktop scaling', () => {
  assert.deepEqual(windowOnCapture(
    { x: 1950, y: 100, w: 900, h: 600 }, { x: 1920, y: 0, w: 2560, h: 1440 }, { width: 2560, height: 1440 }
  ), { x: 30, y: 100, w: 900, h: 600 })
})
test('Retina window points become physical image pixels', () => {
  assert.deepEqual(windowOnCapture(
    { x: 100, y: 80, w: 800, h: 500 }, { x: 0, y: 0, w: 1512, h: 982 }, { width: 3024, height: 1964 }
  ), { x: 200, y: 160, w: 1600, h: 1000 })
})
test('a window spanning a left-hand Retina monitor is clipped before scaling', () => {
  assert.deepEqual(windowOnCapture(
    { x: -200, y: 100, w: 500, h: 400 }, { x: -1440, y: 0, w: 1440, h: 900 }, { width: 2880, height: 1800 }
  ), { x: 2480, y: 200, w: 400, h: 800 })
})
test('each monitor uses its own capture scale in a mixed-DPI setup', () => {
  const window = { x: 1400, y: 200, w: 400, h: 300 }
  assert.deepEqual(windowOnCapture(window, { x: 0, y: 0, w: 1512, h: 982 }, { width: 3024, height: 1964 }),
    { x: 2800, y: 400, w: 224, h: 600 })
  assert.deepEqual(windowOnCapture(window, { x: 1512, y: 0, w: 1920, h: 1080 }, { width: 1920, height: 1080 }),
    { x: 0, y: 200, w: 288, h: 300 })
})
test('non-overlapping and invalid monitor rectangles are ignored', () => {
  const monitor = { x: 0, y: 0, w: 1440, h: 900 }
  const image = { width: 2880, height: 1800 }
  assert.equal(windowOnCapture({ x: 1500, y: 0, w: 600, h: 400 }, monitor, image), null)
  assert.equal(windowOnCapture({ x: 0, y: 0, w: 600, h: 400 }, { ...monitor, w: 0 }, image), null)
})
