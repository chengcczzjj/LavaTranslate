import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, webcrypto, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
const require = createRequire(import.meta.url)
const compile = (path, deps = {}, globals = {}) => {
  const module = { exports: {} }
  runInNewContext(transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module, require: id => id in deps ? deps[id] : require(id), Buffer, setImmediate, AbortSignal, Response, Request, TextEncoder, TextDecoder, crypto: webcrypto, ...globals })
  return module.exports
}
const { votes } = compile('../services/offline-survey/votes.ts')
function database() {
  const ids = new Set()
  return { ids, prepare(sql) { return { bind(id) { this.id = id; return this }, async first() { return { count: ids.size } }, sql } }, async batch(statements) {
    ids.add(statements[0].id)
    return [{}, { results: [{ count: ids.size }] }]
  } }
}
const bodyFor = installation => {
  const hour = Math.floor(Date.now() / 3600000)
  for (let nonce = 0; nonce <= 10000000; nonce++) {
    const digest = createHash('sha256').update(`offline-1.13gb-v1:${installation}:${hour}:${nonce}`).digest()
    if (!digest[0] && !digest[1]) return { installation, hour, nonce }
  }
  throw Error('proof failed')
}
const request = body => new Request('https://example.test/api/votes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
test('anonymous votes deduplicate retries and expose only totals', async () => {
  const db = database(), body = bodyFor(randomUUID())
  const results = await Promise.all([votes(request(body), db), votes(request(body), db)])
  for (const response of results) assert.equal((await response.json()).count, 1)
  assert.equal(db.ids.size, 1)
  assert.notEqual([...db.ids][0], body.installation)
  assert.equal((await (await votes(new Request('https://example.test/api/votes'), db)).json()).threshold, 11)
})
test('invalid, expired and oversized votes cannot modify the count', async () => {
  const db = database()
  for (const body of [null, {}, { ...bodyFor(randomUUID()), hour: 1 }, { data: 'x'.repeat(513) }]) {
    assert.ok((await votes(request(body), db)).status >= 400)
  }
  assert.equal(db.ids.size, 0)
})
test('a second installation contributes exactly one additional vote', async () => {
  const db = database()
  for (let i = 0; i < 2; i++) await votes(request(bodyFor(randomUUID())), db)
  assert.equal(db.ids.size, 2)
})
function client(fetch) {
  const data = { offlineSurveyId: '', offlineSurveyDismissed: false }
  const api = compile('../src/main/offline-survey.ts', { './settings': { settings: { get: () => data, update: patch => Object.assign(data, patch) } } }, { fetch })
  return { data, submit: api.submitOfflineVote }
}
test('lost response preserves ID for retry; acknowledgment hides the card', async () => {
  const bodies = []
  const h = client(async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    assert.equal(h.data.offlineSurveyId, bodies.at(-1).installation)
    if (bodies.length === 1) throw Error('network lost')
    return Response.json({ ok: true, campaign: 'offline-1.13gb-v1' })
  })
  await assert.rejects(h.submit())
  assert.equal(h.data.offlineSurveyDismissed, false)
  await h.submit()
  assert.equal(h.data.offlineSurveyDismissed, true)
  assert.equal(bodies[0].installation, bodies[1].installation)
  await h.submit()
  assert.equal(bodies.length, 2)
})
test('HTTP failure and malformed acknowledgments leave survey retryable', async () => {
  for (const response of [new Response('', { status: 503 }), Response.json({ ok: true, campaign: 'wrong' })]) {
    const h = client(async () => response)
    await assert.rejects(h.submit())
    assert.equal(h.data.offlineSurveyDismissed, false)
  }
})
