import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { sha256hex } from '../src/crypto'
import file from '../src/demo-items.json'
import { call, clock, demoSession, req } from './helpers'

beforeEach(() => {
  clock.t = 1_795_000_000
})

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status)
  expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(await res.text()).toBe(JSON.stringify({ error: code }))
}

async function insertCode(code: string, expiresIn = 600, accountId = 1) {
  await env.DB.prepare('INSERT INTO pair_codes (code_hash, account_id, expires_at) VALUES (?1, ?2, ?3)')
    .bind(await sha256hex(`code:${code}`), accountId, clock.t + expiresIn)
    .run()
}

const send = (id: string, token: string, body: string, ip?: string) =>
  call(req(`/api/items/${id}/send`, { method: 'POST', token, body, ip }))

describe('POST /api/session', () => {
  it('answers a 43-character token, demo mode, 7200 s, and stores only its SHA-256', async () => {
    const res = await call(req('/api/session', { method: 'POST', body: '{"mode":"demo"}' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['expires_in', 'mode', 'session'])
    expect(body.mode).toBe('demo')
    expect(body.expires_in).toBe(7200)
    expect(body.session).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const rows = await env.DB.prepare('SELECT * FROM sessions').all()
    expect(rows.results).toHaveLength(1)
    expect(JSON.stringify(rows.results)).not.toContain(body.session as string)
    expect(rows.results[0]!.token_hash).toBe(await sha256hex(body.session as string))
  })

  it.each([
    ['paired mode', '{"mode":"paired"}'],
    ['an extra field', '{"mode":"demo","x":1}'],
    ['no body', ''],
    ['not JSON', 'mode=demo'],
    ['an array', '["demo"]'],
    ['over 200 bytes', JSON.stringify({ mode: 'demo', pad: 'x'.repeat(200) })],
  ])('refuses %s with 400 bad_request', async (_, body) => {
    await expectError(await call(req('/api/session', { method: 'POST', body })), 400, 'bad_request')
  })

  it('allows 20 per address per hour, then 429 rate_limited with retry-after; another address still works', async () => {
    for (let i = 0; i < 20; i++) await demoSession('192.0.2.1')
    const res = await call(req('/api/session', { method: 'POST', body: '{"mode":"demo"}', ip: '192.0.2.1' }))
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(3500)
    await expectError(res, 429, 'rate_limited')
    await demoSession('192.0.2.2')
    clock.t += 3601
    await demoSession('192.0.2.1')
  })

  it('stops at 2,000 a day in total with 429 daily_cap', async () => {
    const day = new Date(clock.t * 1000).toISOString().slice(0, 10)
    await env.DB.prepare('INSERT INTO counters (key, count, window_end) VALUES (?1, 2000, ?2)')
      .bind(`session:day:${day}`, clock.t + 999)
      .run()
    await expectError(await call(req('/api/session', { method: 'POST', body: '{"mode":"demo"}' })), 429, 'daily_cap')
  })

  it('never lets two requests at the same moment both take the last slot (25 at once → exactly 20)', async () => {
    const all = await Promise.all(
      Array.from({ length: 25 }, () => call(req('/api/session', { method: 'POST', body: '{"mode":"demo"}', ip: '192.0.2.50' }))),
    )
    expect(all.filter((r) => r.status === 200)).toHaveLength(20)
    expect(all.filter((r) => r.status === 429)).toHaveLength(5)
  })
})

describe('GET /api/items', () => {
  it('returns the bundled items in the file order for a demo session', async () => {
    const token = await demoSession()
    const res = await call(req('/api/items', { token }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ mode: 'demo', items: file.items, voice: true })
  })

  it.each([
    ['no header', {}],
    ['a wrong scheme', { headers: { authorization: 'Basic abc' } }],
    ['an unknown token', { token: 'A'.repeat(43) }],
    ['a short token', { token: 'abc' }],
  ])('answers 401 unauthorized with %s', async (_, init) => {
    await expectError(await call(req('/api/items', init)), 401, 'unauthorized')
  })

  it('never reads the token from a query string or a cookie', async () => {
    const token = await demoSession()
    await expectError(await call(req(`/api/items?session=${token}&token=${token}`)), 401, 'unauthorized')
    await expectError(await call(req('/api/items', { headers: { cookie: `session=${token}` } })), 401, 'unauthorized')
  })

  it('answers 401 once the demo session expired (2 h)', async () => {
    const token = await demoSession()
    clock.t += 7200
    await expectError(await call(req('/api/items', { token })), 401, 'unauthorized')
  })
})

describe('POST /api/items/<id>/send', () => {
  it('sends nothing, answers {sent:true, real:false}, then the item is gone for this session only', async () => {
    const a = await demoSession()
    const b = await demoSession()
    const res = await send('mail-0', a, '{"choice":0}')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sent: true, real: false })
    const listA = (await (await call(req('/api/items', { token: a }))).json()) as { items: { id: string }[] }
    expect(listA.items.map((i) => i.id)).toEqual(['tg-0', 'mail-1'])
    const listB = (await (await call(req('/api/items', { token: b }))).json()) as { items: unknown[] }
    expect(listB.items).toHaveLength(3)
    await expectError(await send('mail-0', a, '{"choice":2}'), 409, 'already_handled')
  })

  it('accepts choices 1 to 4 (the alternatives)', async () => {
    const t = await demoSession()
    for (const [id, c] of [['tg-0', 4], ['mail-0', 1], ['mail-1', 3]] as const) {
      expect((await send(id, t, JSON.stringify({ choice: c }))).status).toBe(200)
    }
  })

  it.each([
    ['choice 5', '{"choice":5}'],
    ['choice -1', '{"choice":-1}'],
    ['choice 1.5', '{"choice":1.5}'],
    ['choice as a string', '{"choice":"1"}'],
    ['no choice', '{}'],
    ['a text field', '{"choice":0,"text":"Wire the money"}'],
    ['an address field', '{"choice":0,"to":"someone@example.com"}'],
    ['a body over 200 bytes', JSON.stringify({ choice: 0, pad: ' '.repeat(190) })],
    ['not JSON', 'choice=0'],
  ])('refuses %s with 400 and marks nothing', async (_, body) => {
    const t = await demoSession()
    await expectError(await send('mail-0', t, body), 400, 'bad_request')
    expect((await send('mail-0', t, '{"choice":0}')).status).toBe(200)
  })

  it('accepts a valid body of exactly 200 bytes (the limit is « over 200 »)', async () => {
    const t = await demoSession()
    const body = `{"choice":0}${' '.repeat(200 - 12)}`
    expect(new TextEncoder().encode(body).byteLength).toBe(200)
    expect((await send('mail-0', t, body)).status).toBe(200)
  })

  it('answers 404 for an unknown id and 401 without a session', async () => {
    const t = await demoSession()
    await expectError(await send('mail-9', t, '{"choice":0}'), 404, 'not_found')
    await expectError(await send('..%2Fx', t, '{"choice":0}'), 404, 'not_found')
    await expectError(await call(req('/api/items/mail-0/send', { method: 'POST', body: '{"choice":0}' })), 401, 'unauthorized')
  })

  it('two sends of the same item at the same moment: exactly one wins', async () => {
    const t = await demoSession()
    const all = await Promise.all(Array.from({ length: 6 }, () => send('mail-1', t, '{"choice":0}')))
    expect(all.filter((r) => r.status === 200)).toHaveLength(1)
    expect(all.filter((r) => r.status === 409)).toHaveLength(5)
  })

  it('allows 30 tries per session, then 429 rate_limited', async () => {
    const t = await demoSession()
    for (let i = 0; i < 30; i++) expect((await send('mail-0', t, '{"choice":9}')).status).toBe(400)
    const res = await send('mail-0', t, '{"choice":0}')
    expect(res.headers.get('retry-after')).not.toBeNull()
    await expectError(res, 429, 'rate_limited')
  })

  it('allows 60 per address per hour across sessions, then 429', async () => {
    const ip = '192.0.2.77'
    for (let s = 0; s < 3; s++) {
      const t = await demoSession(ip)
      for (let i = 0; i < 20; i++) expect((await send('mail-0', t, '{"choice":9}', ip)).status).toBe(400)
    }
    const t = await demoSession(ip)
    await expectError(await send('mail-0', t, '{"choice":0}', ip), 429, 'rate_limited')
  })

  it('stops at 3,000 a day in total with daily_cap', async () => {
    const t = await demoSession()
    const day = new Date(clock.t * 1000).toISOString().slice(0, 10)
    await env.DB.prepare('INSERT INTO counters (key, count, window_end) VALUES (?1, 3000, ?2)')
      .bind(`send:day:${day}`, clock.t + 999)
      .run()
    await expectError(await send('mail-0', t, '{"choice":0}'), 429, 'daily_cap')
  })
})

describe('POST /api/items/<id>/skip', () => {
  it('answers {skipped:true}, hides the item, then 409; 404 unknown; 400 with a body; 401 without session', async () => {
    const t = await demoSession()
    const skip = (id: string, body?: string, token: string | null = t) =>
      call(req(`/api/items/${id}/skip`, { method: 'POST', token: token ?? undefined, body }))
    await expectError(await skip('tg-0', '{"x":1}'), 400, 'bad_request')
    const res = await skip('tg-0')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ skipped: true })
    await expectError(await skip('tg-0'), 409, 'already_handled')
    await expectError(await send('tg-0', t, '{"choice":0}'), 409, 'already_handled')
    await expectError(await skip('nope'), 404, 'not_found')
    await expectError(await skip('tg-0', undefined, null), 401, 'unauthorized')
    const list = (await (await call(req('/api/items', { token: t }))).json()) as { items: { id: string }[] }
    expect(list.items.map((i) => i.id)).toEqual(['mail-0', 'mail-1'])
  })
})

describe('POST /api/pair/claim', () => {
  const claim = (code: unknown, ip = '203.0.113.20') =>
    call(req('/api/pair/claim', { method: 'POST', body: JSON.stringify({ code }), ip }))

  it('turns a live code into a paired session (7 days) that reads its own account (day 3: no demo items)', async () => {
    // day 4 (§ 3.6): a paired route serves only an account of today's ALLOWED_ACCOUNTS, so the row is that account's
    await env.DB.prepare(
      `INSERT INTO accounts (id, email_hash, refresh_iv, refresh_ct, scope, created_at, updated_at, self_hash)
       VALUES (1, ?1, 'iv', 'ct', '', 0, 0, 'sh')`,
    )
      .bind(await sha256hex('email:allowed.demo@example.com'))
      .run()
    await insertCode('123456')
    const res = await claim('123456')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: string; mode: string; expires_in: number }
    expect(Object.keys(body).sort()).toEqual(['expires_in', 'mode', 'session'])
    expect(body.mode).toBe('paired')
    expect(body.expires_in).toBe(604800)
    expect(body.session).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await (await call(req('/api/items', { token: body.session }))).json()).toEqual({ mode: 'paired', items: [], voice: true })
  })

  it('gives the same 404 for a wrong, a used and an expired code', async () => {
    await insertCode('111111')
    await insertCode('222222', 600)
    expect((await claim('111111', '203.0.113.1')).status).toBe(200)
    await expectError(await claim('111111', '203.0.113.2'), 404, 'not_found') // used
    await expectError(await claim('999999', '203.0.113.3'), 404, 'not_found') // wrong
    clock.t += 600
    await expectError(await claim('222222', '203.0.113.4'), 404, 'not_found') // expired
  })

  it.each([['5 digits', '12345'], ['letters', '12a456'], ['a number', 123456]])('answers 400 for %s', async (_, code) => {
    await expectError(await claim(code), 400, 'bad_request')
  })

  it('allows 5 tries per address per 10 minutes, then 429 even with a good code', async () => {
    await insertCode('424242', 3600)
    for (let i = 0; i < 5; i++) await expectError(await claim('000000', '203.0.113.30'), 404, 'not_found')
    const res = await claim('424242', '203.0.113.30')
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    await expectError(res, 429, 'rate_limited')
    clock.t += 601
    expect((await claim('424242', '203.0.113.30')).status).toBe(200)
  })

  it('after 20 failed claims from all addresses in 10 minutes, refuses every claim for 10 minutes', async () => {
    await insertCode('777777', 3600)
    for (let i = 0; i < 20; i++) await expectError(await claim('000001', `198.51.100.${i}`), 404, 'not_found')
    const res = await claim('777777', '198.51.100.200')
    expect(Number(res.headers.get('retry-after'))).toBe(600)
    await expectError(res, 429, 'rate_limited')
    clock.t += 599
    await expectError(await claim('777777', '198.51.100.201'), 429, 'rate_limited')
    clock.t += 1
    expect((await claim('777777', '198.51.100.202')).status).toBe(200)
  })

  it('19 failures do not lock', async () => {
    await insertCode('888888')
    for (let i = 0; i < 19; i++) await claim('000001', `198.51.100.${i}`)
    expect((await claim('888888', '198.51.100.250')).status).toBe(200)
  })

  it('a code claimed twice at the same moment works once', async () => {
    await insertCode('313131')
    const all = await Promise.all(Array.from({ length: 5 }, (_, i) => claim('313131', `192.0.2.${100 + i}`)))
    expect(all.filter((r) => r.status === 200)).toHaveLength(1)
    expect(all.filter((r) => r.status === 404)).toHaveLength(4)
  })
})

describe('lazy purge', () => {
  it('a new session deletes expired sessions, handled marks, codes, states and counters', async () => {
    const t = await demoSession()
    await send('mail-0', t, '{"choice":0}')
    await insertCode('101010')
    clock.t += 8000
    await demoSession('192.0.2.99')
    const counts = await env.DB.batch<{ n: number }>(
      ['sessions', 'handled', 'pair_codes'].map((x) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${x}`)),
    )
    expect(counts.map((c) => c.results[0]!.n)).toEqual([1, 0, 0])
  })
})
