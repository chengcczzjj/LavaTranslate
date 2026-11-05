import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { stripTypeScriptTypes } from 'node:module'
import { matchesTargetLanguage } from '../src/main/ocr-language.ts'

test('skip aligned OCR locally, preserving mixed languages and Chinese script conversion', async () => {
  for (const [target, texts, expected] of [
    ['zh-Hans', ['退出', '这是已经识别出来的中文。', '2026'], true],
    ['zh-Hant', ['你好', '這行文字已經是繁體中文。'], true],
    ['zh-Hans', ['這行文字已經是繁體中文。'], false],
    ['zh-Hant', ['这行文字是简体中文。'], false],
    ['zh-Hans', ['日本語の文章です。'], false],
    ['zh-Hans', ['设置', 'Open the settings'], false],
    ['zh-Hans', ['本地识别 OCR 文字，第 10 行。', '在 Windows 11 上按 Ctrl+C。', 'API'], true],
    ['zh-Hant', ['取得 API 金鑰，再按 Ctrl+C 複製。'], true],
    ['zh-Hans', ['设置', 'SAVE CHANGES'], false],
    ['zh-Hans', ['中文和 English text'], false],
    ['ja', ['日本語の文章です。'], true],
    ['en', ['This is an English sentence.', '42'], true],
    ['en', ['This is an English sentence.', 'Enregistrer les modifications'], false],
    ['fr', ['Enregistrer les modifications'], true]
  ]) {
    assert.equal(await matchesTargetLanguage(texts.map((text) => ({ text, score: 0.99 })), target), expected, target + ' / ' + texts.join(' / '))
  }
})

test('unreliable, empty and vertical OCR never bypasses image translation as already Chinese', async () => {
  for (const lines of [
    [], [{ text: '', score: 0 }], [{ text: '名：', score: 0.502 }],
    [{ text: '和', score: 0.99, vertical: true }],
    [{ text: '你好', score: 0.99 }, { text: '', score: 0 }]
  ]) assert.equal(await matchesTargetLanguage(lines, 'zh-Hans'), false)
})

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
