const campaign = 'offline-1.13gb-v1'
export const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' }
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers })
export async function votes(request: Request, db: D1Database): Promise<Response> {
  if (request.method === 'GET') {
    const row = await db.prepare('SELECT COUNT(*) AS count FROM votes').first<{ count: number }>()
    return reply({ count: row?.count ?? 0, threshold: 11, campaign })
  }
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405)
  if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'JSON required' }, 415)
  const reader = request.body?.getReader()
  if (!reader) return reply({ error: 'Missing body' }, 400)
  const chunks: Uint8Array[] = []; let length = 0
  while (true) {
    const part = await reader.read(); if (part.done) break
    length += part.value.length
    if (length > 512) { await reader.cancel(); return reply({ error: 'Body too large' }, 413) }
    chunks.push(part.value)
  }
  let input: { installation?: unknown; hour?: unknown; nonce?: unknown }
  try { const body = new Uint8Array(length); let offset = 0; for (const c of chunks) { body.set(c, offset); offset += c.length }; input = JSON.parse(new TextDecoder().decode(body)) } catch { return reply({ error: 'Invalid JSON' }, 400) }
  const { installation, hour, nonce } = input ?? {}
  if (typeof installation !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(installation) ||
      typeof hour !== 'number' || !Number.isSafeInteger(hour) || Math.abs(hour - Math.floor(Date.now() / 3600000)) > 1 ||
      typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0 || nonce > 10000000) return reply({ error: 'Invalid vote' }, 400)
  // Anonymous submission capability: a bounded proof bound to this installation,
  // campaign and hour. No shared application secret or visitor login is needed.
  const proof = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${campaign}:${installation}:${hour}:${nonce}`)))
  if (proof[0] !== 0 || proof[1] !== 0) return reply({ error: 'Invalid proof' }, 403)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(installation)))
  const id = Array.from(digest, n => n.toString(16).padStart(2, '0')).join('')
  const result = await db.batch([
    db.prepare('INSERT OR IGNORE INTO votes (installation) VALUES (?)').bind(id),
    db.prepare('SELECT COUNT(*) AS count FROM votes')
  ])
  return reply({ ok: true, count: (result[1].results[0] as { count: number }).count, threshold: 11, campaign })
}
