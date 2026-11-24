// BRIEF-D4 § 3.6 (ALLOWED_ACCOUNTS read again: D3 review note 5), § 3.7 (skip: checks a and b first, note 8) and
// § 3.8 (logout). Written against the day-3 helpers only, so the same file runs on the day-3 code and fails there.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { ALLOWED, call, clock, demoSession, req, testEnv } from './helpers'
import { alias, fakeModules, FakeUpstream, pairedSession, sync, syncEnv, TRIAGE_ANSWER } from './sync-fakes'

const db = (env as Env).DB
const T0 = 1_795_000_000

beforeEach(() => {
  clock.t = T0
})

async function insertMessage(id: string): Promise<void> {
  const acct = await db.prepare('SELECT id FROM accounts').first<{ id: number }>()
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (account_id, msg_id, thread_id, persona, received_at, state, tries, created_at)
         VALUES (?1, ?2, ?3, 'marco', ?4, 'done', 1, ?4)`,
      )
      .bind(acct!.id, id, `t-${id}`, T0 - 600),
    db
      .prepare('INSERT INTO triage_results (id, result, created_at) VALUES (?1, ?2, ?3)')
      .bind(`${acct!.id}:${id}`, JSON.stringify({ ...TRIAGE_ANSWER, provider: 'fake' }), T0),
  ])
}

/** Everything a destructive check could touch. */
const state = () =>
  db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM sessions) AS sessions,
              (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM triage_results) AS results,
              (SELECT group_concat(needs_signin) FROM accounts) AS needs, (SELECT group_concat(refresh_ct) FROM accounts) AS grants,
              (SELECT COUNT(*) FROM messages WHERE handled_at IS NOT NULL) AS handled`,
    )
    .first()

describe('ALLOWED_ACCOUNTS, read again on every run and every paired request (§ 3.6)', () => {
  for (const list of ['', undefined, '  ,  ', 'second@example.net']) {
    it(`list ${JSON.stringify(list)}: the sync reads nothing; every paired route → 401; nothing revoked, nothing deleted`, async () => {
      const token = await pairedSession()
      await insertMessage('m1')
      const up = new FakeUpstream()
      up.mails.push({ id: 'm9', from: alias('marco'), at: T0 - 100 })
      const before = await state()
      const r = await sync(up, fakeModules(), syncEnv({ ALLOWED_ACCOUNTS: list }))
      expect(up.calls).toEqual([]) // no token refresh, no read, no revoke
      expect(r.accounts).toBe(0)
      const e = testEnv({ ALLOWED_ACCOUNTS: list, REAL_SEND: 'on' })
      for (const [method, path, body] of [
        ['GET', '/api/items', undefined],
        ['GET', '/api/calendar', undefined],
        ['POST', '/api/items/m1/send', '{"choice":0}'],
        ['POST', '/api/items/m1/skip', undefined],
      ] as const) {
        const res = await call(req(path, { method, token, body }), { env: e, fetch: up.fetch })
        expect(res.status, path).toBe(401)
        expect(await res.json()).toEqual({ error: 'unauthorized' })
      }
      expect(up.calls).toEqual([])
      expect(await state()).toEqual(before)
      // back on the list: the same session works again, no new sign-in needed
      expect((await call(req('/api/items', { token }))).status).toBe(200)
      expect((await sync(up, fakeModules())).accounts).toBe(1)
    })
  }

  it('the list is compared without case and spaces, as at sign-in', async () => {
    const token = await pairedSession()
    expect((await call(req('/api/items', { token }), { env: testEnv({ ALLOWED_ACCOUNTS: `  ${ALLOWED.toUpperCase()} ` }) })).status).toBe(200)
  })
})

describe('POST /api/items/<id>/skip, paired: checks a and b first (§ 3.7, D3 review note 8)', () => {
  it('a dead grant → 403 signin_needed and the item is NOT marked handled', async () => {
    const token = await pairedSession()
    await insertMessage('m1')
    await db.prepare('UPDATE accounts SET needs_signin = 1').run()
    const res = await call(req('/api/items/m1/skip', { method: 'POST', token }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'signin_needed' })
    expect((await state())!.handled).toBe(0)
  })

  it('REAL_SEND on and a scope without gmail.send → 403 (check b in full), nothing handled; off → as day 3', async () => {
    const token = await pairedSession()
    await insertMessage('m1')
    const on = testEnv({ REAL_SEND: 'on' })
    expect((await call(req('/api/items/m1/skip', { method: 'POST', token }), { env: on })).status).toBe(403)
    expect((await state())!.handled).toBe(0)
    expect((await call(req('/api/items/m1/skip', { method: 'POST', token }))).status).toBe(200)
    expect((await call(req('/api/items/m1/skip', { method: 'POST', token }))).status).toBe(409)
  })

  it('then as day 3: unknown id → 404, a body → 400', async () => {
    const token = await pairedSession()
    await insertMessage('m1')
    expect((await call(req('/api/items/nope/skip', { method: 'POST', token }))).status).toBe(404)
    expect((await call(req('/api/items/m1/skip', { method: 'POST', token, body: '{}' }))).status).toBe(400)
  })
})

describe('POST /api/session/logout (§ 3.8)', () => {
  const logout = (token?: string, init: { body?: string; ip?: string } = {}) =>
    call(req('/api/session/logout', { method: 'POST', token, ...init }))

  it('demo: 200 {"ok":true}, the session row is deleted, the token is dead, a second call → 401', async () => {
    const token = await demoSession()
    const res = await logout(token)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ ok: true })
    expect((await state())!.sessions).toBe(0)
    expect((await call(req('/api/items', { token }))).status).toBe(401)
    expect((await logout(token)).status).toBe(401)
  })

  it('paired: the session dies, the account, its grant and its rows stay', async () => {
    const token = await pairedSession()
    await insertMessage('m1')
    const before = await state()
    expect((await logout(token)).status).toBe(200)
    expect((await call(req('/api/items', { token }))).status).toBe(401)
    expect(await state()).toEqual({ ...before, sessions: 0 })
  })

  it('no session, an unknown or an expired one → 401; a body → 400 and the session lives', async () => {
    expect((await logout()).status).toBe(401)
    expect((await logout('A'.repeat(43))).status).toBe(401)
    const token = await demoSession()
    expect((await logout(token, { body: '{}' })).status).toBe(400)
    expect((await call(req('/api/items', { token }))).status).toBe(200)
    clock.t += 7200
    expect((await logout(token)).status).toBe(401)
  })

  it('two logouts at the same moment: one 200, one 401', async () => {
    const token = await demoSession()
    const [a, b] = await Promise.all([logout(token), logout(token)])
    expect([a.status, b.status].sort()).toEqual([200, 401])
  })

  it('30 per address per hour, then 429 with retry-after', async () => {
    for (let i = 0; i < 30; i++) expect((await logout(undefined, { ip: '198.51.100.77' })).status).toBe(401)
    const res = await logout(undefined, { ip: '198.51.100.77' })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate_limited' })
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await logout(undefined, { ip: '198.51.100.78' })).status).toBe(401)
  })
})
