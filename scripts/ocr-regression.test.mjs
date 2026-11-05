import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'
import { unfoldVertical } from '../src/main/ocr-vertical.ts'

const require = createRequire(import.meta.url)
function harness(platform) {
  const calls = { create: [], det: [], rec: [] }
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }) } }
  const ort = { Tensor, InferenceSession: { create: async (file, options) => {
    calls.create.push(options)
    const det = file.endsWith('det.onnx')
    return { outputNames: det ? ['prob'] : ['best_idx'], run: async ({ x }) => {
      if (det) { calls.det.push(x.dims); return { prob: { data: new Float32Array(x.dims[2] * x.dims[3]) } } }
      calls.rec.push(x.dims)
      return { best_idx: { dims: [x.dims[0], 1], data: new BigInt64Array(x.dims[0]) }, best_prob: { data: new Float32Array(x.dims[0]) } }
    } }
  } } }
  const { code } = transformSync(readFileSync(new URL('../src/main/ocr.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' })
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, process: { platform }, performance,
    require: (id) => id === 'onnxruntime-node' ? ort : id === 'node:fs' ? { readFileSync: () => '中\n文\n' } : id === './ocr-vertical' ? { unfoldVertical } : require(id)
  })
  return { ocr: new module.exports.PaddleOcr('models'), calls }
}

test('CPU startup skips synthetic inference and Retina detection stays bounded', async () => {
  const { ocr, calls } = harness('darwin')
  await ocr.init()
  assert.equal(calls.det.length, 0)
  assert.equal(calls.rec.length, 0)
  assert(calls.create.every((c) => c.executionProviders[0] === 'cpu'))
  const width = 3024, height = 1964
  await ocr.recognize({ data: new Uint8Array(width * height * 4).fill(255), width, height })
  const [, , h, w] = calls.det[0]
  assert(w <= 1600 && h <= 1600)
  assert(w * h < 1_650_000, 'padding must not exceed the CPU pixel budget materially')
  assert.equal(calls.det.length, 1, 'one screenshot should run detection once')
})

test('Windows GPU path retains high resolution and GPU warm-up', async () => {
  const { ocr, calls } = harness('win32')
  await ocr.init()
  assert.equal(ocr.provider, 'dml')
  assert.equal(calls.det.length, 2)
  const width = 2000, height = 500
  await ocr.recognize({ data: new Uint8Array(width * height * 4).fill(255), width, height })
  assert(calls.det.at(-1)[3] >= width)
})

test('upright columns preserve glyph orientation and top-to-bottom order', () => {
  const width = 48, height = 120, data = new Uint8Array(width * height * 4).fill(255)
  const mark = (x, y) => { const p = (y * width + x) * 4; data[p] = data[p + 1] = data[p + 2] = 0 }
  // L, then a mirror L: the strip must not rotate, mirror or reverse them.
  for (const top of [10, 70]) for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) {
    if (y >= 24 || (top === 10 ? x < 4 : x >= 24)) mark(10 + x, top + y)
  }
  const strip = unfoldVertical({ data, width, height }, { x: 0, y: 0, w: width, h: height })
  assert(strip)
  assert.equal(strip.glyphs, 2)
  const pixel = (x, y) => strip.data[(y * strip.width + x) * 4]
  assert.equal(pixel(5, 10), 0)
  assert.equal(pixel(40, 10), 255)
  assert.equal(pixel(48 + 5, 10), 255)
  assert.equal(pixel(48 + 40, 10), 0)
  assert.equal(pixel(20, 40), 0)
  assert.equal(pixel(48 + 20, 40), 0)
})

test('blank tall boxes cannot invent an upright strip', () => {
  assert.equal(unfoldVertical({ data: new Uint8Array(40 * 200 * 4).fill(255), width: 40, height: 200 }, { x: 0, y: 0, w: 40, h: 200 }), null)
})
