// BRIEF-D3: the outsider's grant revoked (D2 review note 8), GET /api/calendar, the bundled placeholders, the cron.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validBrief as realValidBrief } from '../../triage/brief'
import calendarFile from '../src/demo-calendar.json'
import type { Env } from '../src/env'
import worker from '../src/index'
import personasFile from '../src/personas.json'
import { checkCalendarFile, checkPersonasFile, DEMO_CALENDAR, PERSONAS } from '../src/personas'
import { ALLOWED, call, clock, FAKE_REFRESH, googleStub, req, startState } from './helpers'
import { realModules } from '../src/wiring'
import { alias, BODY_MARK, fakeModules, FakeUpstream, pairedSession, SUBJECT_MARK, sync, syncAll } from './sync-fakes'

const db = (env as Env).DB
const T0 = 1_795_000_000 // 2026-11-18 11:06:40 UTC = 06:06:40 in Toronto (EST)

beforeEach(() => {
  clock.t = T0
})

describe('an account outside ALLOWED_ACCOUNTS (D2 review, note 8)', () => {
  it('gets its tokens REVOKED at Google: one request to the revoke endpoint with the token, never logged, nothing stored', async () => {
    const log = vi.spyOn(console, 'log')
    const g = googleStub('stranger@example.org')
    const res = await call(req(`/oauth/callback?state=${await startState()}&code=x`), { fetch: g.fetch })
    expect(res.status).toBe(403)
    expect(g.calls).toHaveLength(2)
    expect(g.calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
    expect(g.calls[1]!.url).toBe('https://oauth2.googleapis.com/revoke')
    expect(Object.fromEntries(new URLSearchParams(g.calls[1]!.body))).toEqual({ token: FAKE_REFRESH })
    const logged = log.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(logged).not.toContain(FAKE_REFRESH)
    expect(logged).not.toContain('stranger')
    expect((await db.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>())!.n).toBe(0)
  })

  it('a revoke endpoint that fails or throws changes nothing: still the « not open yet » page', async () => {
    const g = googleStub('stranger@example.org')
    const fetch = async (u: string, i?: RequestInit) => {
      if (u.endsWith('/revoke')) throw new Error('network down')
      return g.fetch(u, i)
    }
    const res = await call(req(`/oauth/callback?state=${await startState()}&code=x`), { fetch })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('Not open yet')
  })

  it('an allowed account is never revoked', async () => {
    const g = googleStub(ALLOWED)
    expect((await call(req(`/oauth/callback?state=${await startState()}&code=x`), { fetch: g.fetch })).status).toBe(200)
    expect(g.calls.map((c) => c.url)).toEqual(['https://oauth2.googleapis.com/token'])
  })
})

describe('bundled placeholders (§ 3.6)', () => {
  it('src/personas.json follows § 3.6 and matches the dataset', () => {
    expect(checkPersonasFile(personasFile)).toEqual([])
    expect(PERSONAS).not.toBeNull()
    expect(PERSONAS!.map((p) => p.key)).toEqual(['marco', 'priya', 'jordan', 'lina'])
    expect(PERSONAS!.find((p) => p.key === 'lina')).toEqual({
      key: 'lina',
      name: 'Lina',
      fullName: 'Lina Chen',
      address: 'lina.chen@acme-packaging.example.com',
      company: 'Acme Packaging',
    })
  })

  it('src/demo-calendar.json follows § 3.4 (now 12:41, events after now, limits)', () => {
    expect(checkCalendarFile(calendarFile)).toEqual([])
    expect(DEMO_CALENDAR!.now).toBe('12:41')
    // Frozen demo data, not a model answer: the dataset's « carton order #4471 late » has a « # », which validBrief
    // refuses for MODEL briefs (markdown character). The demo file is served as frozen; paired briefs are validated.
    const lina = DEMO_CALENDAR!.events[0]!.brief!
    expect(realValidBrief(lina)).toBeNull()
    expect(realValidBrief({ ...lina, why: 'carton order 4471 late' })).not.toBeNull()
  })

  it('the checkers refuse what § 3.4 / 3.6 forbid', () => {
    const ok = { start: '14:00', title: 'Supplier call', who: '' }
    expect(checkCalendarFile({ now: '12:41', events: [{ ...ok, title: 'x'.repeat(61) }] })).not.toEqual([])
    expect(checkCalendarFile({ now: '12:41', events: [{ ...ok, start: '12:00' }] })).not.toEqual([])
    expect(checkCalendarFile({ now: '12:41', events: [{ ...ok, brief: { why: 'a', last: 'b', facts: [] } }] })).not.toEqual([])
    expect(checkCalendarFile({ now: '12:41', events: [{ ...ok, extra: 1 }] })).not.toEqual([])
    expect(checkCalendarFile({ now: '12:41', events: Array(6).fill(ok) })).not.toEqual([])
    const p = { key: 'x', name: 'X', fullName: 'X Y', address: 'x@real-company.invalid', company: 'C' } // not an example domain (a reserved name, nobody's)
    expect(checkPersonasFile({ personas: [p] })).not.toEqual([])
    expect(checkPersonasFile({ personas: [{ ...p, address: 'x@a.example.com', more: 1 }] })).not.toEqual([])
  })
})

describe('GET /api/calendar (§ 3.4)', () => {
  it('demo: 200 with the frozen file; no session → 401', async () => {
    const res = await call(req('/api/session', { method: 'POST', body: '{"mode":"demo"}' }))
    const t = ((await res.json()) as { session: string }).session
    const cal = await call(req('/api/calendar', { token: t }))
    expect(cal.status).toBe(200)
    expect(cal.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(cal.headers.get('cache-control')).toBe('no-store')
    expect(await cal.json()).toEqual({ mode: 'demo', now: '12:41', events: calendarFile.events })
    const none = await call(req('/api/calendar'))
    expect(none.status).toBe(401)
    expect(await none.json()).toEqual({ error: 'unauthorized' })
  })

  it('paired: own events only, safe titles only, today after now, persona → who, a valid brief → brief', async () => {
    const token = await pairedSession()
    const up = new FakeUpstream()
    up.mails = [
      { id: 'm1', from: alias('lina'), at: T0 - 600 },
      { id: 'm2', from: alias('lina'), at: T0 - 900 },
    ]
    up.events = [
      { id: 'e1', summary: 'Supplier call', start: T0 + 3600, attendees: ['x@example.org', alias('lina')] },
      { id: 'e2', summary: 'Invite from outside', start: T0 + 4000, creatorSelf: false, organizerSelf: false },
      { id: 'e3', summary: 'See https://evil.example.com', start: T0 + 5000 },
      { id: 'e4', summary: 'Plan with boss@example.com', start: T0 + 5100 },
      { id: 'e5', summary: 'A'.repeat(80), start: T0 + 6000 },
      { id: 'e6', summary: 'All day thing', start: T0, allDay: true },
      { id: 'e7', summary: 'Tomorrow early', start: T0 + 20 * 3600 },
    ]
    const mods = fakeModules()
    await sync(up, mods)
    // the brief came from that persona's mails of the label, fetched again by id
    expect(mods.briefCalls).toHaveLength(1)
    expect(mods.briefCalls[0]!.persona.key).toBe('lina')
    expect(mods.briefCalls[0]!.mails).toHaveLength(2)
    expect(mods.briefCalls[0]!.start).toBe('07:06')
    const res = await call(req('/api/calendar', { token }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      mode: 'paired',
      now: '06:06',
      events: [
        {
          start: '07:06',
          title: 'Supplier call',
          who: 'Lina Chen, Acme Packaging',
          brief: { why: 'carton order late', last: 'she promised Friday', facts: ['corrugator down since Monday', 'new ship date Thursday'] },
        },
        { start: '07:46', title: 'A'.repeat(60), who: '' },
      ],
    })
    // the next run makes no new brief request
    const before = mods.briefCalls.length
    await sync(up, mods)
    expect(mods.briefCalls.length).toBe(before)
  })

  it('paired: a stored brief that fails validation is not served (the event stays, without brief)', async () => {
    const token = await pairedSession()
    const up = new FakeUpstream()
    up.events = [{ id: 'e1', summary: 'Supplier call', start: T0 + 3600 }]
    await sync(up, fakeModules())
    await db.prepare("UPDATE events SET brief = ?1 WHERE event_id = 'e1'").bind(JSON.stringify({ why: 'mail x@example.com', last: 'y', facts: ['z'] })).run()
    const body = (await (await call(req('/api/calendar', { token }))).json()) as { events: Array<Record<string, unknown>> }
    expect(body.events).toEqual([{ start: '07:06', title: 'Supplier call', who: '' }])
  })

  it('paired: an event that has started is gone; an event deleted at Google leaves on the next run', async () => {
    const token = await pairedSession()
    const up = new FakeUpstream()
    up.events = [
      { id: 'e1', summary: 'First', start: T0 + 600 },
      { id: 'e2', summary: 'Second', start: T0 + 1200 },
    ]
    await sync(up, fakeModules())
    clock.t = T0 + 900
    let body = (await (await call(req('/api/calendar', { token }))).json()) as { events: Array<{ title: string }> }
    expect(body.events.map((e) => e.title)).toEqual(['Second'])
    up.events = []
    await sync(up, fakeModules())
    body = (await (await call(req('/api/calendar', { token }))).json()) as { events: Array<{ title: string }> }
    expect(body.events).toEqual([])
  })
})

describe('the scheduled handler', () => {
  it('exists on the default export and runs a sync with no account without any network call', async () => {
    expect(typeof worker.scheduled).toBe('function')
    const log = vi.spyOn(console, 'log')
    const ctx = createExecutionContext()
    // day 4 (§ 6.3): the handler awaits the run itself (15 min of wall time), so the test awaits the handler
    await worker.scheduled!({ cron: '*/2 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env as Env, ctx)
    await waitOnExecutionContext(ctx)
    expect(log.mock.calls.some((c) => String(c[0]).includes('"route":"sync.done"'))).toBe(true)
  })
})

describe('wiring: the real modules of job B', () => {
  it('a sync with the real fromGmail on Gmail-shaped messages: 2 persona mails triaged, the stranger and the other account ignored', async () => {
    const token = await pairedSession()
    const up = new FakeUpstream()
    up.gmailFormat = true
    up.mails = [
      { id: 'g1', from: `"Marco Bellini" <${alias('marco')}>`, at: T0 - 600 },
      { id: 'g2', from: alias('priya'), at: T0 - 900 },
      { id: 'g3', from: 'Someone <someone@example.org>', at: T0 - 1000 },
      { id: 'g4', from: 'other.person+lina@example.com', at: T0 - 1100 },
    ]
    const r = await syncAll(up, realModules)
    expect(r).toMatchObject({ triaged: 2, ignored: 2, failed: 0 })
    const text = await (await call(req('/api/items', { token }))).text()
    expect((JSON.parse(text) as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(['g1', 'g2'])
    for (const s of [SUBJECT_MARK, BODY_MARK, ALLOWED, '+']) expect(text).not.toContain(s)
  })
})
