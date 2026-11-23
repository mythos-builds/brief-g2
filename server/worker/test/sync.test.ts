// BRIEF-D3 § 6, the sync (§ 3.5) and the paired routes (§ 3.2 to 3.4), on a stubbed Google and model.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dayKey } from '../../triage/budget'
import demoFile from '../src/demo-items.json'
import type { Env } from '../src/env'
import { upstreams } from '../src/google'
import { ALLOWED, call, clock, FAKE_REFRESH, googleStub, req, startState, testEnv } from './helpers'
import {
  alias,
  BODY_MARK,
  cachedAccess,
  fakeModules,
  FakeUpstream,
  insertAccount,
  LABEL_ID,
  OPENROUTER,
  pairedSession,
  SUBJECT_MARK,
  sync,
  syncEnv,
} from './sync-fakes'

const db = (env as Env).DB
const T0 = 1_795_000_000 // 2026-11-18 11:06:40 UTC = 06:06:40 in Toronto (EST)

/** 2 persona mails, 1 stranger, 1 alias of another account. */
function inbox(up: FakeUpstream): void {
  up.mails = [
    { id: 'm1', from: `"Marco Bellini" <${alias('marco')}>`, at: T0 - 3600 },
    { id: 'm2', from: alias('priya'), at: T0 - 600 },
    { id: 'm3', from: 'someone@example.org', at: T0 - 1200 },
    { id: 'm4', from: 'other.person+lina@example.com', at: T0 - 1800 },
  ]
}

async function items(token: string, e?: Env) {
  const res = await call(req('/api/items', { token }), e ? { env: e } : {})
  return { status: res.status, text: await res.text() }
}

const ALLOWED_CALL = [
  /^POST https:\/\/oauth2\.googleapis\.com\/token$/,
  /^POST https:\/\/oauth2\.googleapis\.com\/revoke$/,
  /^GET https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/labels$/,
  new RegExp(`^GET https://gmail\\.googleapis\\.com/gmail/v1/users/me/messages\\?labelIds=${LABEL_ID}&maxResults=20$`),
  /^GET https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/[A-Za-z0-9_-]+\?format=full$/,
  /^GET https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\?timeMin=[^&]+&timeMax=[^&]+&singleEvents=true&orderBy=startTime&maxResults=5$/,
  /^POST https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/,
]

/** Every recorded call is one of decision 1.3 (+ the model), and every messages.get is for an id a list returned. */
function onlyAllowedCalls(up: FakeUpstream): void {
  for (const c of up.calls) expect(ALLOWED_CALL.some((r) => r.test(`${c.method} ${c.url}`)), `${c.method} ${c.url}`).toBe(true)
  const listed = new Set(up.mails.map((m) => m.id))
  for (const c of up.calls) {
    const m = /\/messages\/([^/?]+)\?/.exec(c.url)
    if (m) expect(listed.has(m[1]!)).toBe(true)
  }
}

beforeEach(() => {
  clock.t = T0
})

/** The id of the first account (ids keep counting across tests: AUTOINCREMENT). */
async function firstAccount(): Promise<number> {
  return (await db.prepare('SELECT MIN(id) AS id FROM accounts').first<{ id: number }>())!.id
}

describe('sync: messages', () => {
  it('2 persona mails, 1 stranger, 1 alias of another account → 2 triaged once, 2 ignored; a second run calls no model and no messages.get', async () => {
    const token = await pairedSession()
    const up = new FakeUpstream()
    inbox(up)
    const mods = fakeModules()
    const r1 = await sync(up, mods)
    expect(r1).toMatchObject({ accounts: 1, triaged: 2, ignored: 2, failed: 0, capped: false })
    expect(up.modelCalls).toBe(2)
    expect(up.gets).toBe(4)
    onlyAllowedCalls(up)
    const states = await db.prepare('SELECT msg_id, state, persona FROM messages ORDER BY msg_id').all()
    expect(states.results).toEqual([
      { msg_id: 'm1', state: 'done', persona: 'marco' },
      { msg_id: 'm2', state: 'done', persona: 'priya' },
      { msg_id: 'm3', state: 'ignored', persona: null },
      { msg_id: 'm4', state: 'ignored', persona: null },
    ])

    const before = up.calls.length
    const r2 = await sync(up, mods)
    expect(r2).toMatchObject({ triaged: 0, ignored: 0 })
    const second = up.calls.slice(before)
    expect(second.filter((c) => c.url === OPENROUTER)).toHaveLength(0)
    expect(second.filter((c) => /\/messages\/[^/?]+\?/.test(c.url))).toHaveLength(0)

    const res = await items(token)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.text) as { mode: string; items: Array<Record<string, unknown>> }
    expect(body.mode).toBe('paired')
    // newest first; identity from the persona table, `at` in America/Toronto
    expect(body.items.map((i) => i.id)).toEqual(['m2', 'm1'])
    expect(body.items[0]).toEqual({
      id: 'm2',
      source: 'mail',
      persona: 'priya',
      name: 'Priya',
      fullName: 'Priya Nair',
      address: 'p.nair@riverside-foods.example.net',
      at: '05:56',
      summary: TRIAGE_SUMMARY,
      draft: 'Yes, I can cover Friday on line 1.',
      alts: ['Yes, I will be there.', 'No, I cannot make it.', 'I will confirm later today.', 'What time do you need me?'],
    })
  })

  it('two runs at the same moment triage each message once', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    inbox(up)
    const [a, b] = await Promise.all([sync(up, fakeModules()), sync(up, fakeModules())])
    expect(a.triaged + b.triaged).toBe(2)
    expect(up.modelCalls).toBe(2)
    const n = await db.prepare('SELECT COUNT(*) AS n FROM triage_results').first<{ n: number }>()
    expect(n!.n).toBe(2)
  })

  it('the daily cap reached → no model call (and no message fetched for it)', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    inbox(up)
    await db
      .prepare('INSERT INTO counters (key, count, window_end) VALUES (?1, 30, ?2)')
      .bind(dayKey('triage', T0 * 1000), T0 + 86_400)
      .run()
    const r = await sync(up, fakeModules())
    expect(r.triaged).toBe(0)
    expect(up.modelCalls).toBe(0)
    expect(up.gets).toBe(0)
  })

  it('the daily cap is counted in D1 and stops triage mid-run: cap 1 → 1 model call, the other message waits', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    inbox(up)
    const r = await sync(up, fakeModules(), syncEnv({ TRIAGE_DAILY_CAP: '1' }))
    expect(r.triaged).toBe(1)
    expect(up.modelCalls).toBe(1)
    const waiting = await db.prepare("SELECT state, tries FROM messages WHERE state = 'retry'").all()
    expect(waiting.results).toEqual([{ state: 'retry', tries: 0 }])
    // the next UTC day: it is triaged
    clock.t = T0 + 86_400
    up.mails.forEach((m) => (m.at += 86_400))
    const r2 = await sync(up, fakeModules(), syncEnv({ TRIAGE_DAILY_CAP: '1' }))
    expect(r2.triaged).toBe(1)
  })

  it('the cap of 40 requests per run → a clean stop at exactly 40, nothing left claimed', async () => {
    await pairedSession()
    const others = ['second@example.net', 'third@example.net', 'fourth@example.net', 'fifth@example.net']
    for (const o of others) await insertAccount(o)
    const up = new FakeUpstream()
    // 5 accounts, each with 5 persona mails of its own: at least 9 requests per account (refresh, labels, list,
    // 5 gets, calendar) → more than 40 in one run
    for (const acct of [ALLOWED, ...others])
      for (const [i, k] of ['marco', 'priya', 'lina', 'jordan', 'marco'].entries())
        up.mails.push({ id: `${acct.slice(0, 3)}${i}`, from: alias(k, acct), at: T0 - 100 * (i + 1) })
    const log = vi.spyOn(console, 'log')
    const r = await sync(up, fakeModules())
    expect(r.capped).toBe(true)
    expect(r.requests).toBe(40)
    expect(up.calls).toHaveLength(40)
    const claimed = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE state = 'claimed'").first<{ n: number }>()
    expect(claimed!.n).toBe(0)
    expect(log.mock.calls.some((c) => String(c[0]).includes('"route":"sync.cap"'))).toBe(true)
  })

  it('a failed triage leaves the message for a later run, 3 tries at most', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    up.mails = [{ id: 'm1', from: alias('marco'), at: T0 - 60 }]
    up.modelStatus = 503
    for (let i = 0; i < 4; i++) await sync(up, fakeModules())
    const row = await db.prepare('SELECT state, tries FROM messages').first()
    expect(row).toEqual({ state: 'failed', tries: 3 })
    const modelAfter3 = up.modelCalls
    await sync(up, fakeModules())
    expect(up.modelCalls).toBe(modelAfter3)
  })

  it('a missing model key: nothing is triaged, the NAME is logged, the routes keep working', async () => {
    const token = await pairedSession()
    const up = new FakeUpstream()
    inbox(up)
    const log = vi.spyOn(console, 'log')
    const r = await sync(up, fakeModules(), syncEnv({ OPENROUTER_API_KEY: '' }))
    expect(r.triaged).toBe(0)
    expect(up.modelCalls).toBe(0)
    expect(log.mock.calls.some((c) => String(c[0]).includes('OPENROUTER_API_KEY'))).toBe(true)
    expect((await items(token)).status).toBe(200)
  })

  it('no label named exactly DEMO_LABEL → nothing is read', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    inbox(up)
    up.labels = [{ id: 'L1', name: 'Brief-Demo' }]
    await sync(up, fakeModules())
    expect(up.count((c) => c.url.includes('/messages'))).toBe(0)
  })

  it('caches the access token sealed and renews it only when under 5 minutes are left', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    const refreshes = () => up.count((c) => c.url.endsWith('/token'))
    await sync(up, fakeModules())
    expect(refreshes()).toBe(1)
    const row = await db.prepare('SELECT access_ct FROM accounts').first<{ access_ct: string }>()
    expect(row!.access_ct).not.toContain('fake-access')
    expect(await cachedAccess(await firstAccount())).toBe('fake-access-1')
    clock.t = T0 + 3599 - 301
    await sync(up, fakeModules())
    expect(refreshes()).toBe(1)
    clock.t = T0 + 3599 - 299
    await sync(up, fakeModules())
    expect(refreshes()).toBe(2)
  })
})

const TRIAGE_SUMMARY = 'can you cover Friday'

describe('dead grant', () => {
  it('invalid_grant → needs_signin → 403 signin_needed on items and calendar; skipped by the sync; a new sign-in clears it', async () => {
    const token = await pairedSession()
    const up = new FakeUpstream()
    inbox(up)
    up.deadRefresh.add(FAKE_REFRESH)
    const r = await sync(up, fakeModules())
    expect(r.signin).toBe(1)
    expect(up.calls).toHaveLength(1) // the refresh only
    for (const path of ['/api/items', '/api/calendar']) {
      const res = await call(req(path, { token }))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'signin_needed' })
    }
    // skipped until a new sign-in replaces its refresh token
    await sync(up, fakeModules())
    expect(up.calls).toHaveLength(1)

    const NEW_REFRESH = 'fresh-refresh-token-for-tests-only'
    const g = googleStub(ALLOWED, { refresh_token: NEW_REFRESH })
    expect((await call(req(`/oauth/callback?state=${await startState()}&code=n`), { fetch: g.fetch })).status).toBe(200)
    expect((await call(req('/api/items', { token }))).status).toBe(200)
    expect((await call(req('/api/calendar', { token }))).status).toBe(200)
    await sync(up, fakeModules())
    expect(up.calls.length).toBeGreaterThan(1)
  })
})

describe('paired routes', () => {
  async function seeded() {
    const token = await pairedSession()
    const up = new FakeUpstream()
    inbox(up)
    await sync(up, fakeModules())
    return { token, up }
  }

  it('a stored result that fails validation is never served (items, send, skip)', async () => {
    const { token } = await seeded()
    await db
      .prepare(
        `INSERT INTO messages (account_id, msg_id, persona, received_at, state, created_at) VALUES (?2, 'bad1', 'marco', ?1, 'done', 0),
         (?2, 'bad2', 'priya', ?1, 'done', 0)`,
      )
      .bind(T0, await firstAccount())
      .run()
    const acc = await firstAccount()
    await db
      .prepare('INSERT INTO triage_results (id, result, created_at) VALUES (?1, ?2, 0), (?3, ?4, 0)')
      .bind(
        `${acc}:bad1`,
        JSON.stringify({ ...TRIAGE_ANSWER_BAD, provider: 'x' }),
        `${acc}:bad2`,
        '{not json',
      )
      .run()
    const body = JSON.parse((await items(token)).text) as { items: Array<{ id: string }> }
    expect(body.items.map((i) => i.id)).toEqual(['m2', 'm1'])
    expect((await call(req('/api/items/bad1/send', { method: 'POST', token, body: '{"choice":0}' }))).status).toBe(404)
    expect((await call(req('/api/items/bad1/skip', { method: 'POST', token }))).status).toBe(404)
  })

  it('handled is recorded for the ACCOUNT: another session no longer sees the item; a second call → 409', async () => {
    const { token } = await seeded()
    const other = await pairedSession('203.0.113.51')
    const res = await call(req('/api/items/m2/send', { method: 'POST', token, body: '{"choice":2}' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sent: true, real: false })
    const seen = JSON.parse((await items(other)).text) as { items: Array<{ id: string }> }
    expect(seen.items.map((i) => i.id)).toEqual(['m1'])
    expect((await call(req('/api/items/m2/send', { method: 'POST', token: other, body: '{"choice":0}' }))).status).toBe(409)
    expect((await call(req('/api/items/m2/skip', { method: 'POST', token: other }))).status).toBe(409)
    const sk = await call(req('/api/items/m1/skip', { method: 'POST', token: other }))
    expect(await sk.json()).toEqual({ skipped: true })
    expect(JSON.parse((await items(token)).text).items).toEqual([])
    const row = await db.prepare("SELECT handled_action, handled_choice FROM messages WHERE msg_id = 'm2'").first()
    expect(row).toEqual({ handled_action: 'send', handled_choice: 2 })
  })

  it('same refusals as day 2: a text, an extra field, a choice out of range → 400; an ignored or unknown id → 404', async () => {
    const { token } = await seeded()
    const send = (id: string, body: string) => call(req(`/api/items/${id}/send`, { method: 'POST', token, body }))
    expect((await send('m1', '{"choice":0,"text":"hi"}')).status).toBe(400)
    expect((await send('m1', '{"choice":5}')).status).toBe(400)
    expect((await send('m1', '{"text":"hi"}')).status).toBe(400)
    expect((await send('m3', '{"choice":0}')).status).toBe(404) // a stranger's mail, stored ignored
    expect((await send('mail-0', '{"choice":0}')).status).toBe(404) // a demo id is not this account's
    expect((await call(req('/api/items/m1/send', { method: 'POST', body: '{"choice":0}' }))).status).toBe(401)
  })

  it('a demo session is unchanged by the sync (bundled items, per session)', async () => {
    await seeded()
    const res = await call(req('/api/session', { method: 'POST', body: '{"mode":"demo"}' }))
    const t = ((await res.json()) as { session: string }).session
    const body = JSON.parse((await items(t)).text) as { mode: string; items: Array<{ id: string }> }
    expect(body.mode).toBe('demo')
    expect(body.items).toEqual(demoFile.items)
  })

  it('no answer of any route ever contains the account address, a + alias, a subject or a body', async () => {
    const { token, up } = await seeded()
    up.events = [{ id: 'e1', summary: 'Supplier call', start: T0 + 3600, attendees: [alias('lina')] }]
    up.mails.push({ id: 'm5', from: alias('lina'), at: T0 - 30 })
    await sync(up, fakeModules())
    const texts: string[] = []
    const grab = async (r: Request) => texts.push(await (await call(r)).text())
    await grab(req('/api/items', { token }))
    await grab(req('/api/calendar', { token }))
    await grab(req('/api/items/m1/send', { method: 'POST', token, body: '{"choice":1}' }))
    await grab(req('/api/items/m2/skip', { method: 'POST', token }))
    await grab(req('/api/items/m1/send', { method: 'POST', token, body: '{"choice":1}' }))
    await grab(req('/api/items/m9/send', { method: 'POST', token, body: '{"choice":1}' }))
    expect(texts.join('\n')).toContain('Supplier call')
    for (const t of texts) {
      expect(t.toLowerCase()).not.toContain(ALLOWED)
      expect(t.toLowerCase()).not.toContain('allowed.demo')
      expect(t).not.toContain('+')
      expect(t).not.toContain(SUBJECT_MARK)
      expect(t).not.toContain(BODY_MARK)
    }
    // nor is any of it stored
    const dump = JSON.stringify(
      await Promise.all(['accounts', 'messages', 'triage_results', 'events'].map((t) => db.prepare(`SELECT * FROM ${t}`).all())),
    )
    for (const s of [ALLOWED, 'allowed.demo+', SUBJECT_MARK, BODY_MARK, 'fake-access-']) expect(dump).not.toContain(s)
  })
})

const TRIAGE_ANSWER_BAD = {
  needs_reply: true,
  summary: 'mail me',
  draft: 'Write to boss@example.com today.',
  alts: ['Yes, I will be there.', 'No, I cannot make it.', 'I will confirm later today.', 'What time do you need me?'],
}

describe('dev base addresses (§ 3.8)', () => {
  const dev = {
    GOOGLE_TOKEN_URL: 'http://127.0.0.1:8799/token',
    GOOGLE_REVOKE_URL: 'http://127.0.0.1:8799/revoke',
    GMAIL_BASE: 'http://127.0.0.1:8799',
    CALENDAR_BASE: 'http://127.0.0.1:8799',
    MODEL_BASE: 'http://127.0.0.1:8799',
  }

  it('are ignored when ENV is not "dev" (production, empty, "Dev")', () => {
    for (const ENV of ['production', '', 'Dev', undefined]) {
      expect(upstreams(testEnv({ ...dev, ENV }))).toEqual({
        tokenUrl: 'https://oauth2.googleapis.com/token',
        revokeUrl: 'https://oauth2.googleapis.com/revoke',
        gmailBase: 'https://gmail.googleapis.com',
        calendarBase: 'https://www.googleapis.com',
        modelBase: undefined,
      })
    }
  })

  it('are used when ENV is "dev"', () => {
    expect(upstreams(testEnv({ ...dev, ENV: 'dev' }))).toEqual({
      tokenUrl: 'http://127.0.0.1:8799/token',
      revokeUrl: 'http://127.0.0.1:8799/revoke',
      gmailBase: 'http://127.0.0.1:8799',
      calendarBase: 'http://127.0.0.1:8799',
      modelBase: 'http://127.0.0.1:8799',
    })
  })

  it('a sync in production with the five vars set still calls only the real addresses', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    inbox(up)
    await sync(up, fakeModules(), syncEnv({ ...dev, ENV: 'production' }))
    expect(up.calls.length).toBeGreaterThan(5)
    expect(up.calls.some((c) => c.url.includes('127.0.0.1'))).toBe(false)
    onlyAllowedCalls(up)
  })

  it('a sync in dev calls the fake for Google and the model', async () => {
    await pairedSession()
    const seen: string[] = []
    const up = new FakeUpstream()
    inbox(up)
    // map the fake origin back onto the stub so the same fixtures answer
    const devFetch = async (u: string, i?: RequestInit) => {
      seen.push(u)
      const real = u
        .replace('http://127.0.0.1:8799/token', 'https://oauth2.googleapis.com/token')
        .replace('http://127.0.0.1:8799/gmail/', 'https://gmail.googleapis.com/gmail/')
        .replace('http://127.0.0.1:8799/calendar/', 'https://www.googleapis.com/calendar/')
        .replace('http://127.0.0.1:8799/api/', 'https://openrouter.ai/api/')
      return up.fetch(real, i)
    }
    const { runSync } = await import('../src/sync')
    const r = await runSync(syncEnv({ ...dev, ENV: 'dev' }), { fetch: devFetch, now: () => clock.t }, fakeModules())
    expect(r.triaged).toBe(2)
    expect(seen.length).toBeGreaterThan(5)
    expect(seen.every((u) => u.startsWith('http://127.0.0.1:8799/'))).toBe(true)
  })
})
