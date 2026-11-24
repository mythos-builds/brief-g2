// D3 review (reports/D3-review.md), findings 3 and 4, on the stubbed Google and model of sync-fakes.ts.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { MODEL_START_BEFORE_S, RUN_WALL_S } from '../src/sync'
import { clock } from './helpers'
import { alias, fakeModules, FakeUpstream, LABEL_ID, OPENROUTER, pairedSession, sync } from './sync-fakes'

const db = (env as Env).DB
const T0 = 1_795_000_000

beforeEach(() => {
  clock.t = T0
})

const listCalls = (up: FakeUpstream, from = 0) =>
  up.calls.slice(from).filter((c) => /\/messages\?/.test(c.url)).map((c) => new URL(c.url).searchParams.get('labelIds'))
const gets = (up: FakeUpstream, from = 0) => up.calls.slice(from).filter((c) => /\/messages\/[^/?]+\?/.test(c.url)).length

describe('D3 finding 4: the label id is checked against DEMO_LABEL on every run', () => {
  it('a label renamed away from brief-demo is never read again; the new brief-demo is', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    up.mails = [{ id: 'm1', from: alias('marco'), at: T0 - 60 }]
    await sync(up, fakeModules())
    expect(listCalls(up)).toEqual([LABEL_ID])

    // the owner renames brief-demo to « archive » (its id stays valid) and makes a new brief-demo
    up.labels = [
      { id: LABEL_ID, name: 'archive' },
      { id: 'Label_new', name: 'brief-demo' },
    ]
    up.listLabel = 'Label_new'
    up.mails = [{ id: 'n1', from: alias('priya'), at: T0 - 30 }]
    const before = up.calls.length
    await sync(up, fakeModules())
    expect(listCalls(up, before)).toEqual(['Label_new'])
    const row = await db.prepare('SELECT label_id FROM accounts').first<{ label_id: string | null }>()
    expect(row!.label_id).toBe('Label_new')
  })

  it('brief-demo deleted: the cached id is dropped and nothing is listed or fetched', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    up.mails = [{ id: 'm1', from: alias('marco'), at: T0 - 60 }]
    await sync(up, fakeModules())
    up.labels = [{ id: LABEL_ID, name: 'old-brief-demo' }]
    up.mails.push({ id: 'm2', from: alias('lina'), at: T0 - 10 })
    const before = up.calls.length
    await sync(up, fakeModules())
    expect(listCalls(up, before)).toEqual([])
    expect(gets(up, before)).toBe(0)
    const row = await db.prepare('SELECT label_id FROM accounts').first<{ label_id: string | null }>()
    expect(row!.label_id).toBeNull()
  })
})

describe('D3 finding 3: a run fits the scheduled time limit', () => {
  it('no new model call after MODEL_START_BEFORE_S; the rest waits for the next run, unclaimed and with no try spent', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    up.mails = ['marco', 'priya', 'lina', 'jordan', 'marco'].map((k, i) => ({ id: `s${i}`, from: alias(k), at: T0 - 100 * (i + 1) }))
    // every model call takes 13 s (D4 review, FIX 1: a run now takes NEW_PER_RUN = 2 messages, so the second one must
    // fall after MODEL_START_BEFORE_S for the deadline to show)
    const inner = up.fetch
    up.fetch = async (input, init) => {
      if (input === OPENROUTER) clock.t += 13
      return inner(input, init)
    }
    const r1 = await sync(up, fakeModules())
    expect(MODEL_START_BEFORE_S).toBeLessThanOrEqual(15)
    expect(r1.triaged).toBe(1) // started at 0 s; at 13 s none starts
    expect(r1.late).toBe(true)
    expect(up.modelCalls).toBe(1)
    expect(gets(up)).toBe(1) // nothing is fetched for a triage that will not start
    const left = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE state != 'done'").first<{ n: number }>()
    expect(left!.n).toBe(0)

    for (let i = 0; i < 4; i++) expect((await sync(up, fakeModules())).triaged).toBe(1)
    expect((await sync(up, fakeModules())).triaged).toBe(0)
    const tries = await db.prepare('SELECT MAX(tries) AS t FROM messages').first<{ t: number }>()
    expect(tries!.t).toBe(1)
  })

  it('each model call gets a deadline that ends inside the run wall time', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    up.mails = [{ id: 'b1', from: alias('lina'), at: T0 - 600 }]
    up.events = [{ id: 'ev1', summary: 'Supplier call', start: T0 + 3600, attendees: [alias('lina')] }]
    const mods = fakeModules()
    const seen: Array<number | undefined> = []
    const brief = mods.meetingBrief
    mods.meetingBrief = async (input, o) => {
      seen.push(o?.deadlineMs)
      return brief(input, o)
    }
    clock.t = T0
    const inner = up.fetch
    up.fetch = async (input, init) => {
      if (input === OPENROUTER) clock.t += 4
      return inner(input, init)
    }
    const r = await sync(up, mods)
    expect(r.briefs).toBe(1)
    expect(seen).toHaveLength(1)
    // the triage took 4 s → the brief may use at most RUN_WALL_S - 4 s
    expect(seen[0]).toBe((RUN_WALL_S - 4) * 1000)
  })

  it('the calendar is read before any message, and a calendar refusal does not block the mail', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    up.mails = [{ id: 'm1', from: alias('marco'), at: T0 - 60 }]
    await sync(up, fakeModules())
    const cal = up.calls.findIndex((c) => c.url.includes('/calendar/v3/'))
    const firstGet = up.calls.findIndex((c) => /\/messages\/[^/?]+\?/.test(c.url))
    expect(cal).toBeGreaterThan(-1)
    expect(cal).toBeLessThan(firstGet)

    const up2 = new FakeUpstream()
    up2.mails = [{ id: 'm9', from: alias('priya'), at: T0 - 30 }]
    const inner = up2.fetch
    up2.fetch = async (input, init) =>
      input.includes('/calendar/v3/') ? Response.json({ error: { code: 403 } }, { status: 403 }) : inner(input, init)
    const r = await sync(up2, fakeModules())
    expect(r.triaged).toBe(1)
  })
})

describe('D3 notes 7 and 13: which events are kept, and how titles are cut', () => {
  it('note 7: an event Google made from a mail (eventType fromGmail) is not kept, even with self set', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    up.events = [
      { id: 'own', summary: 'Supplier call', start: T0 + 600, eventType: 'default' },
      { id: 'plain', summary: 'Line check', start: T0 + 900 },
      { id: 'mailed', summary: 'Call Marco now re overdue invoice', start: T0 + 1200, eventType: 'fromGmail' },
    ]
    await sync(up, fakeModules())
    const rows = await db.prepare('SELECT event_id FROM events ORDER BY start_at').all<{ event_id: string }>()
    expect(rows.results.map((r) => r.event_id)).toEqual(['own', 'plain'])
  })

  it('note 13: a title is cut so its .length (what the routes check) is 60 at most, never mid-character', async () => {
    await pairedSession()
    const up = new FakeUpstream()
    // 59 letters + a 2-unit character: 60 code points but 61 UTF-16 units
    up.events = [{ id: 'emoji', summary: `${'a'.repeat(59)}\u{1F600}tail`, start: T0 + 600 }]
    await sync(up, fakeModules())
    const row = await db.prepare('SELECT title FROM events').first<{ title: string }>()
    expect(row).not.toBeNull()
    expect(row!.title.length).toBeLessThanOrEqual(60)
    expect(row!.title).toBe('a'.repeat(59))
  })
})
