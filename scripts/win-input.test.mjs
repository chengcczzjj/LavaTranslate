import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

const stateFile = new URL('../src/main/win-space-state.ts', import.meta.url)
const workerFile = new URL('../src/main/win-space-worker.ts', import.meta.url)
const compile = (file) => transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
const stateCode = compile(stateFile), workerCode = compile(workerFile)

function run(steps, options = {}) {
  let clock = 10000, callback
  const held = new Set(), sent = [], masked = []
  const calls = { install: 0, uninstall: 0, timerKilled: 0, callbackReleased: 0 }
  const date = { now: () => clock }
  const constants = { exports: {} }
  runInNewContext(stateCode, { module: constants, Date: date })
  const { KEY_STATE: S, KEY_STATE_SIZE, deadline, live } = constants.exports
  const state = new Int32Array(new SharedArrayBuffer(KEY_STATE_SIZE * 4))
  const h = {
    S, state, held, sent, masked, calls, live,
    advance: (ms) => { clock += ms },
    beat: () => { state[S.mainUntil] = deadline(1500) },
    mode: (mode) => { state[S.mode] = mode; state[S.revision]++; if (!mode) state[S.reset]++ },
    capture: (on) => { state[S.capture] = Number(on); state[S.captureUntil] = on ? deadline(1500) : 0; state[S.revision]++; if (!on) state[S.reset]++ },
    press: (key, up = false, code = 0) => callback(code, up ? 0x101 : 0x100, key),
    events: () => sent.filter((v) => typeof v === 'string' && v !== 'ready')
  }
  h.beat()
  const queue = steps(h)
  const native = {
    SetWindowsHookExW: () => { calls.install++; return options.failInstall ? null : 1 },
    UnhookWindowsHookEx: () => { calls.uninstall++ },
    CallNextHookEx: () => 42,
    PeekMessageW: () => {},
    SetTimer: () => options.failTimer ? 0 : 123,
    KillTimer: () => { calls.timerKilled++ },
    GetAsyncKeyState: (key) => held.has(key) ? 0x8000 : 0,
    keybd_event: (key, _scan, flags) => masked.push([key, flags]),
    GetCurrentThreadId: () => 123,
    GetModuleHandleW: () => 1,
    GetMessageW: () => { const step = queue.shift(); if (!step) return 0; step(); return 1 }
  }
  const koffi = {
    load: () => ({ func: (signature) => native[signature.match(/__stdcall (\w+)\(/)[1]] }),
    proto: () => {}, pointer: () => {}, decode: (value) => value,
    register: (fn) => { callback = fn; return fn }, unregister: () => { calls.callbackReleased++ }
  }
  runInNewContext(workerCode, {
    Buffer, Date: date, Atomics, Int32Array,
    require: (id) => id === './win-space-state' ? constants.exports : id === 'koffi' ? koffi : {
      workerData: state.buffer, parentPort: { postMessage: (s) => sent.push(s), close: () => {} }
    }
  })
  assert.equal(calls.callbackReleased, 1)
  assert.equal(calls.timerKilled, 1)
  return h
}

test('ordinary shortcut idle has no native hook; enabling and disabling install/uninstall it', () => {
  run((h) => [
    () => { assert.equal(h.calls.install, 0); h.mode(1) },
    () => { assert.equal(h.calls.install, 1); h.mode(0) },
    () => { assert.equal(h.calls.uninstall, 1); assert.equal(h.press(0x20), 42) }
  ])
})

test('Win+Space preserves other keys, modifiers, repeat, recording and masks without Ctrl', () => {
  const h = run((h) => [
    () => h.mode(1),
    () => {
      assert.equal(h.press(0x20), 42)
      h.held.add(0x5b)
      assert.equal(h.press(0x41), 42)
      assert.equal(h.press(0x20, false, -1), 42)
      for (const key of [0x10, 0x11, 0x12]) {
        h.held.add(key); assert.equal(h.press(0x20), 42); h.held.delete(key)
      }
      assert.equal(h.press(0x20), 1)
      assert.equal(h.press(0x20), 1)
      assert.equal(h.press(0x20, true), 1)
      assert.deepEqual(h.events(), ['press'])
      h.mode(2)
    },
    () => { assert.equal(h.press(0x20), 1); assert.equal(h.press(0x20, true), 1); assert.deepEqual(h.events(), ['press', 'record']) }
  ])
  assert.deepEqual(h.masked, [[0xe8, 0], [0xe8, 2], [0xe8, 0], [0xe8, 2]])
})

test('holding Space after releasing Win hands off to scrolling, with one event per hold', () => {
  run((h) => [
    () => { h.mode(1); h.capture(true) },
    () => {
      h.held.add(0x5b); assert.equal(h.press(0x20), 1)
      h.held.clear(); assert.equal(h.press(0x5b, true), 42)
      assert.equal(h.state[h.S.held], 1)
      assert.equal(h.press(0x20), 1)
      assert.equal(h.press(0x20, true), 1)
      assert.equal(h.state[h.S.held], 0)
      assert.deepEqual(h.events(), ['press', 'scroll'])
      assert.equal(h.press(0x20), 1); assert.equal(h.press(0x20, true), 1)
      assert.deepEqual(h.events(), ['press', 'scroll', 'scroll'])
    }
  ])
})

test('main thread stall expires input in the callback before the watchdog tick', () => {
  run((h) => [
    () => { h.mode(1); h.capture(true) },
    () => {
      assert.equal(h.press(0x20), 1)
      h.advance(1600)
      assert.equal(h.press(0x20), 42)
      assert.equal(h.press(0x41), 42)
      assert.equal(h.state[h.S.held], 0)
      assert.equal(h.state[h.S.capture], 0)
    },
    () => { assert.equal(h.calls.uninstall, 1); h.beat() },
    () => { assert.equal(h.calls.install, 2); assert.equal(h.press(0x20), 42) }
  ])
})

test('renderer stall expires capture even when the main process continues heartbeating', () => {
  run((h) => [
    () => h.capture(true),
    () => { assert.equal(h.press(0x20), 1); h.advance(1600); h.beat() },
    () => {
      assert.equal(h.calls.uninstall, 1)
      assert.equal(h.press(0x20), 42)
      assert.equal(h.press(0x20, true), 42)
      assert.equal(h.state[h.S.held], 0)
      assert.ok(h.events().includes('expired'))
    }
  ])
})

test('closing capture while a key is held releases it, including fast close/reopen', () => {
  run((h) => [
    () => h.capture(true),
    () => { assert.equal(h.press(0x20), 1); h.capture(false); h.capture(true); assert.equal(h.press(0x20, true), 42); h.capture(false) },
    () => { assert.equal(h.press(0x20), 42); assert.equal(h.state[h.S.held], 0) }
  ])
})

test('a lost shortcut release does not swallow a later unrelated Space', () => {
  run((h) => [
    () => h.mode(1),
    () => {
      h.held.add(0x5b); assert.equal(h.press(0x20), 1)
      h.held.clear(); h.advance(1300); h.beat()
      assert.equal(h.press(0x20), 42)
      assert.equal(h.press(0x20, true), 42)
    }
  ])
})

test('native registration failure is acknowledged instead of reporting success', () => {
  run((h) => [() => h.mode(1), () => assert.equal(h.sent.at(-1).ok, false)], { failInstall: true })
})

test('missing key-up without any later input cannot leave scrollHeld stuck forever', () => {
  run((h) => [
    () => h.capture(true),
    () => { assert.equal(h.press(0x20), 1); h.advance(5100); h.beat(); h.capture(true) },
    () => assert.equal(h.state[h.S.held], 0)
  ])
})

test('deadline arithmetic remains valid across signed 32-bit clock wrap', () => {
  run((h) => [() => {
    h.advance(0x7fffffff - 10000 - 500)
    h.beat(); h.capture(true)
    assert.equal(h.press(0x20), 1)
    h.advance(1600)
    assert.equal(h.press(0x20), 42)
    assert.equal(h.live(0), false)
  }])
})
