// D2 review (reports/D2-review.md), findings 1, 2 and 3: each test failed on the code before the fix.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { sha256hex } from '../src/crypto'
import { addressKey } from '../src/limits'
import { call, clock, demoSession, req } from './helpers'

beforeEach(() => {
  clock.t = 1_795_000_000
})

const day = () => new Date(clock.t * 1000).toISOString().slice(0, 10)
async function counter(key: string): Promise<number> {
  const row = await env.DB.prepare('SELECT count FROM counters WHERE key = ?1').bind(key).first<{ count: number }>()
  return row?.count ?? 0
}

describe('finding 1: a refused hit never counts toward a wider limit', () => {
  it('25 session requests from one address leave the daily total at 20', async () => {
    for (let i = 0; i < 25; i++) await call(req('/api/session', { method: 'POST', body: '{"mode":"demo"}', ip: '192.0.2.77' }))
    expect(await counter(`session:day:${day()}`)).toBe(20)
  })

  it('40 sends from one session leave the per-address and daily totals at 30', async () => {
    const token = await demoSession('192.0.2.78')
    for (let i = 0; i < 40; i++)
      await call(req('/api/items/mail-0/send', { method: 'POST', token, body: '{}', ip: '192.0.2.78' }))
    expect(await counter(`send:day:${day()}`)).toBe(30)
  })
})

describe('finding 3: the global pairing limit holds under a burst, and IPv6 is keyed by its /64', () => {
  const claim = (code: string, ip: string) =>
    call(req('/api/pair/claim', { method: 'POST', body: JSON.stringify({ code }), ip }))

  it('60 wrong codes at the same moment from 30 addresses: at most 20 are tried', async () => {
    const all = await Promise.all(Array.from({ length: 60 }, (_, i) => claim('000002', `198.51.100.${i % 30}`)))
    expect(all.filter((r) => r.status === 404).length).toBeLessThanOrEqual(20)
    expect(all.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(40)
  })

  it('a good claim does not use up a slot of the global limit', async () => {
    for (let i = 0; i < 19; i++) {
      await env.DB.prepare('INSERT INTO pair_codes (code_hash, account_id, expires_at) VALUES (?1, 1, ?2)')
        .bind(await sha256hex(`code:${String(100000 + i)}`), clock.t + 600)
        .run()
      expect((await claim(String(100000 + i), `198.51.100.${i}`)).status).toBe(200)
    }
    for (let i = 0; i < 19; i++) expect((await claim('000003', `203.0.113.${i}`)).status).toBe(404)
  })

  it('two addresses of one IPv6 /64 share a key; another /64 and IPv4 do not', async () => {
    const key = (ip: string) => addressKey(req('/', { ip }))
    expect(await key('2001:db8:1:2::1')).toBe(await key('2001:0db8:0001:0002:ffff:0:0:9'))
    expect(await key('2001:db8:1:2::1')).not.toBe(await key('2001:db8:1:3::1'))
    expect(await key('192.0.2.1')).not.toBe(await key('192.0.2.2'))
  })

  it('21 sessions from 21 addresses of one /64 in an hour: the 21st is refused', async () => {
    for (let i = 1; i <= 20; i++) await demoSession(`2001:db8:aa:bb::${i.toString(16)}`)
    expect((await call(req('/api/session', { method: 'POST', body: '{"mode":"demo"}', ip: '2001:db8:aa:bb::ff' }))).status).toBe(429)
  })
})

describe('finding 2: the deploy steps build the app that talks to the Worker', () => {
  it('README step 1 builds with VITE_DATA_SOURCE=backend and the gate checks the deployed bundle', () => {
    const readme = env.WORKER_README_SOURCE
    const step1 = readme.split('\n').find((l) => l.startsWith('1. Build the app'))
    expect(step1).toContain('VITE_DATA_SOURCE=backend npm run build')
    // the marker exists only in a VITE_DATA_SOURCE=backend bundle (both builds hold the string /api/session)
    expect(readme.match(/grep -c 'VITE_DATA_SOURCE:\.backend\.'/g)?.length).toBe(2)
  })
})
