// BRIEF-D3.md § 4: the retry of « No connection » (fake clock), the paired session in the SDK storage (stubbed
// bridge), `signin_needed`, `GET /api/calendar` feeding the header and screen E, « Disconnect ».
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDataset } from './helpers.ts'
import { memoryStorage, stubBackend, STUB_ACCOUNT, type StubCalendar } from './stub-backend.ts'
import { BackendError, bridgeStorage, createClient, isCalendar, isEvent, PAIRED_KEY } from '../src/data/backend.ts'
import { buildItems, eventsOf, nextOf } from '../src/logic/items.ts'
import { initialState } from '../src/logic/flow.ts'
import { briefPages, pageFor, STATE_TEXT, type PageContext } from '../src/logic/pages.ts'
import { createRetry, retryDelay, type Timers } from '../src/logic/retry.ts'
import { STATIC_ALTS } from '../src/data/static-alts.ts'
import type { CalEvent, Item, TextBox } from '../src/logic/types.ts'

const ds = loadDataset()
const ITEMS: Item[] = buildItems(ds, ['mail'], STATIC_ALTS)
const BASE = 'https://brief.appfinishers.com'
const DEMO_CAL: StubCalendar = { now: '12:41', events: eventsOf(ds).filter((e) => e.start > '12:41') }
const PAIRED_CAL: StubCalendar = {
  now: '09:05',
  events: [
    { start: '09:10', title: 'Supplier call', who: 'Lina Chen, Acme Packaging', brief: { why: 'carton order late', last: 'Nov 14: she promised Friday', facts: ['order #4471', 'corrugator down'] } },
    { start: '12:00', title: 'Line review', who: '' },
  ],
}

async function rejectsWith(p: Promise<unknown>, kind: string) {
  await assert.rejects(p, (e: unknown) => e instanceof BackendError && e.kind === kind)
}

// ---------- 4.1a: « No connection — retrying » retries by itself ----------

function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const t: Timers = {
    set: (fn, ms) => (timers.set(++seq, { at: now + ms, fn }), seq),
    clear: (h) => void timers.delete(h as number),
  }
  function advance(ms: number) {
    const end = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
    }
    now = end
  }
  return { t, advance, pending: () => timers.size, now: () => now }
}

test('4.1a retry: after 2 s, 5 s, 15 s, then every 30 s while the connection stays down', () => {
  const clock = fakeClock()
  const runs: number[] = []
  const retry = createRetry(clock.t, () => {
    runs.push(clock.now())
    retry.disarm() // what load() does first
    retry.arm() // and the load failed again: « No connection » once more
  })
  retry.arm()
  clock.advance(1999)
  assert.deepEqual(runs, [])
  clock.advance(1)
  assert.deepEqual(runs, [2000])
  clock.advance(2000 + 5000 + 15000 + 30000 + 30000)
  assert.deepEqual(runs, [2000, 7000, 22000, 52000, 82000])
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(retryDelay), [2000, 5000, 15000, 30000, 30000, 30000])
})

test('4.1a retry: stops on success; arm is idempotent; a press (disarm + load) retries at once', () => {
  const clock = fakeClock()
  let runs = 0
  const retry = createRetry(clock.t, () => runs++)
  retry.arm()
  retry.arm()
  assert.equal(clock.pending(), 1)
  clock.advance(2000)
  assert.equal(runs, 1)
  assert.equal(retry.done(), 1)
  retry.stop() // the list loaded
  assert.equal(clock.pending(), 0)
  assert.equal(retry.done(), 0)
  clock.advance(120_000)
  assert.equal(runs, 1)
  // a press on « No connection »: main.ts loads at once (disarm), and arms again only if that load failed
  retry.arm()
  retry.disarm()
  assert.equal(clock.pending(), 0)
  clock.advance(60_000)
  assert.equal(runs, 1)
})

test('4.1a retry: no timer while the app is in the background; it resumes when the app is back', () => {
  const clock = fakeClock()
  let runs = 0
  const retry = createRetry(clock.t, () => runs++)
  retry.arm()
  retry.pause()
  assert.equal(clock.pending(), 0)
  clock.advance(600_000)
  assert.equal(runs, 0)
  retry.arm() // a failure seen while in the background arms nothing
  assert.equal(clock.pending(), 0)
  retry.resume()
  assert.equal(retry.armed(), true)
  clock.advance(2000)
  assert.equal(runs, 1)
  // resume with nothing owed arms nothing
  retry.pause()
  retry.resume()
  assert.equal(clock.pending(), 0)
})

// ---------- 4.1c: the paired session in the SDK storage (stubbed bridge) ----------

function stubBridge() {
  const kv = new Map<string, string>()
  const log: string[] = []
  return {
    kv,
    log,
    getLocalStorage: async (k: string) => (log.push(`get ${k}`), kv.get(k) ?? ''),
    setLocalStorage: async (k: string, v: string) => (log.push(`set ${k}`), kv.set(k, v), true),
  }
}

test('4.1c the paired session: kept in the SDK storage, read back after a restart of the app code', async () => {
  const be = stubBackend(ITEMS, { codes: ['123456'], demoCalendar: DEMO_CAL })
  const bridge = stubBridge()
  const c1 = createClient({ base: BASE, fetch: be.fetch, storage: bridgeStorage(bridge) })
  await c1.start()
  await c1.claim('123456')
  assert.match(bridge.kv.get(PAIRED_KEY) ?? '', /^[A-Za-z0-9_-]{43}$/)
  assert.ok(bridge.log.includes(`set ${PAIRED_KEY}`))
  // « restart »: a new client on the same bridge storage, nothing else carried over
  const c2 = createClient({ base: BASE, fetch: be.fetch, storage: bridgeStorage(bridge) })
  assert.equal(await c2.start(), 'paired')
  assert.equal((await c2.items(['mail'])).length, 2)
})

test('4.1c the paired session is removed from the SDK storage on 401, and on « Disconnect » (then demo)', async () => {
  const be = stubBackend(ITEMS, { codes: ['111111', '222222'] })
  const bridge = stubBridge()
  let dropped = 0
  const c = createClient({ base: BASE, fetch: be.fetch, storage: bridgeStorage(bridge), onPairedDropped: () => dropped++ })
  await c.claim('111111')
  be.expireAll()
  await rejectsWith(c.items(['mail']), 'signin')
  assert.equal(bridge.kv.get(PAIRED_KEY), '')
  assert.equal(dropped, 1)
  // pair again, then Disconnect
  await c.claim('222222')
  assert.equal(c.mode(), 'paired')
  await c.disconnect()
  assert.equal(bridge.kv.get(PAIRED_KEY), '')
  assert.equal(c.mode(), undefined)
  assert.equal(dropped, 1) // Disconnect is the user's own act: not reported as a drop
  assert.equal(await c.start(), 'demo')
  const restarted = createClient({ base: BASE, fetch: be.fetch, storage: bridgeStorage(bridge) })
  assert.equal(await restarted.start(), 'demo')
})

// ---------- 4.3: signin_needed (403) ----------

test('4.3 a dead Google grant: 403 signin_needed → « Sign-in needed » on items and calendar; the session is kept; a new sign-in revives it', async () => {
  const be = stubBackend(ITEMS, { codes: ['333333'], pairedCalendar: PAIRED_CAL })
  const storage = memoryStorage()
  const c = createClient({ base: BASE, fetch: be.fetch, storage })
  await c.claim('333333')
  be.state.deadGrant.add(STUB_ACCOUNT)
  await rejectsWith(c.items(['mail']), 'signin')
  await rejectsWith(c.calendar(), 'signin')
  assert.equal(c.mode(), 'paired')
  assert.match(storage.data.get(PAIRED_KEY) ?? '', /^[A-Za-z0-9_-]{43}$/) // NOT forgotten: only a 401 drops it
  assert.equal(be.calls.filter((x) => x.path === '/api/session').length, 0) // never swapped for demo data
  be.state.deadGrant.delete(STUB_ACCOUNT) // the owner signed in again at /connect
  assert.equal((await c.items(['mail'])).length, 2)
  // the F screen names the address to open
  const f = pageFor({ items: [], sent: [], screen: { kind: 'state', which: 'signin' } }, { ds, clock: '', sources: ['mail'], calendar: [] })
  assert.match((f.boxes[0] as TextBox).content, /brief\.appfinishers\.com/)
  assert.equal((f.boxes[0] as TextBox).content, STATE_TEXT.signin)
})

test('3.3 paired: « handled » is per ACCOUNT: another session of the same account no longer sees it; a second call → 409', async () => {
  const be = stubBackend(ITEMS, { codes: ['444444', '555555'] })
  const a = createClient({ base: BASE, fetch: be.fetch, storage: memoryStorage() })
  const b = createClient({ base: BASE, fetch: be.fetch, storage: memoryStorage() })
  await a.claim('444444')
  await b.claim('555555')
  const [first] = await a.items(['mail'])
  await b.items(['mail'])
  assert.deepEqual(await a.send(first.id, first.draft), { real: false })
  assert.deepEqual(
    (await b.items(['mail'])).map((i) => i.id),
    ['mail-1'],
  )
  await rejectsWith(b.skip(first.id), 'handled') // BRIEF-D4.md § 3.11: 409 already_handled → « Already handled. »
  // demo stays per session
  const d1 = createClient({ base: BASE, fetch: be.fetch, storage: memoryStorage() })
  assert.equal((await d1.items(['mail'])).length, 2)
})

// ---------- 4.2: GET /api/calendar → the header, the clock and screen E ----------

test('4.2 calendar: demo answer → the clock and « next 14:00 Supplier call », the same header as static data', async () => {
  const be = stubBackend(ITEMS, { demoCalendar: DEMO_CAL })
  const c = createClient({ base: BASE, fetch: be.fetch, storage: memoryStorage() })
  const items = await c.items(['mail'])
  const cal = await c.calendar()
  assert.equal(cal.mode, 'demo')
  assert.equal(cal.now, '12:41')
  const call = be.calls.find((x) => x.path === '/api/calendar')
  assert.equal(call?.method, 'GET')
  assert.match(call?.auth ?? '', /^Bearer [A-Za-z0-9_-]{43}$/)
  const ctx: PageContext = { ds, clock: cal.now, sources: ['mail'], calendar: cal.events }
  const a = pageFor(initialState(ds, items, { clock: ctx.clock, events: cal.events }), ctx)
  assert.equal((a.boxes[0] as TextBox).content, '2 need you · 12:41 · next 14:00 Supplier call')
  const staticA = pageFor(initialState(ds, ITEMS, { clock: '12:41' }), { ds, clock: '12:41', sources: ['mail'] })
  assert.deepEqual(a, staticA)
})

test('4.2 calendar: paired answer → its own clock, next event, and E due from 10 minutes before an event with a brief', async () => {
  const be = stubBackend(ITEMS, { codes: ['666666'], pairedCalendar: PAIRED_CAL })
  const c = createClient({ base: BASE, fetch: be.fetch, storage: memoryStorage() })
  await c.claim('666666')
  const items = await c.items(['mail'])
  const cal = await c.calendar()
  assert.equal(cal.mode, 'paired')
  const ctx: PageContext = { ds, clock: cal.now, sources: ['mail'], calendar: cal.events }
  const s = initialState(ds, items, { clock: cal.now, events: cal.events })
  assert.deepEqual(s.screen, { kind: 'brief', page: 0 }) // 09:05, the 09:10 event has a brief
  const pages = briefPages(ctx)
  assert.equal(pages[0], '09:10 · Supplier call\nWho: Lina Chen, Acme Packaging\nWhy: carton order late\nLast: Nov 14: she promised Friday')
  assert.equal(pages[1], '• order #4471\n• corrugator down')
  // 08:59: not yet due → A with the paired clock and next event
  const early = initialState(ds, items, { clock: '08:59', events: cal.events })
  assert.deepEqual(early.screen, { kind: 'home' })
  const a = pageFor(early, { ...ctx, clock: '08:59' })
  assert.equal((a.boxes[0] as TextBox).content, '2 need you · 08:59 · next 09:10 Supplier call')
  // the event without a brief never opens E
  assert.deepEqual(initialState(ds, items, { clock: '11:55', events: cal.events }).screen, { kind: 'home' })
})

test('4.2 a failed calendar call never blocks the list: the header simply has no next (and no clock)', async () => {
  const be = stubBackend(ITEMS, { demoCalendar: DEMO_CAL })
  be.state.calendarError = true
  const c = createClient({ base: BASE, fetch: be.fetch, storage: memoryStorage() })
  const items = await c.items(['mail'])
  await rejectsWith(c.calendar(), 'error')
  const ctx: PageContext = { ds, clock: '', sources: ['mail'], calendar: [] }
  const s = initialState(ds, items, { clock: '', events: [] })
  assert.deepEqual(s.screen, { kind: 'home' })
  const a = pageFor(s, ctx)
  assert.equal((a.boxes[0] as TextBox).content, '2 need you')
  assert.equal(nextOf([], ''), undefined)
  // the empty list keeps working too
  assert.equal((pageFor({ ...s, items: [] }, ctx).boxes[0] as TextBox).content, 'Inbox clear √')
})

test('4.2 calendar answers outside § 3.4 are refused (never drawn)', async () => {
  const ok: CalEvent = { start: '14:00', title: 'Supplier call', who: 'Lina Chen, Acme Packaging' }
  assert.equal(isEvent(ok), true)
  assert.equal(isEvent({ ...ok, brief: { why: 'a', last: 'b', facts: ['c'] } }), true)
  const bad: unknown[] = [
    { ...ok, title: 'x'.repeat(61) },
    { ...ok, title: '' },
    { ...ok, start: '2pm' },
    { ...ok, start: '24:00' },
    { ...ok, who: undefined },
    { ...ok, title: 'Call\nnow' },
    { ...ok, address: 'lina@example.com' },
    { ...ok, brief: { why: 'a', last: 'b', facts: [] } },
    { ...ok, brief: { why: 'a', last: 'b', facts: ['1', '2', '3', '4', '5'] } },
    { ...ok, brief: { why: 'y'.repeat(61), last: 'b', facts: ['c'] } },
    { ...ok, brief: { why: 'a', last: 'b', facts: ['f'.repeat(61)] } },
    { ...ok, brief: null },
  ]
  for (const b of bad) assert.equal(isEvent(b), false, JSON.stringify(b))
  assert.equal(isCalendar({ mode: 'demo', now: '12:41', events: [ok] }), true)
  assert.equal(isCalendar({ mode: 'demo', now: '12:41', events: Array(6).fill(ok) }), false)
  assert.equal(isCalendar({ mode: 'other', now: '12:41', events: [] }), false)
  assert.equal(isCalendar({ mode: 'demo', now: '', events: [] }), false)
  const be = stubBackend(ITEMS, { demoCalendar: { now: '12:41', events: [{ ...ok, title: 'x'.repeat(61) }] } })
  const c = createClient({ base: BASE, fetch: be.fetch, storage: memoryStorage() })
  await rejectsWith(c.calendar(), 'error')
})

test('static mode does not change: the dataset calendar in the contract shape gives the same pages', () => {
  const events = eventsOf(ds)
  assert.equal(events.length, ds.calendar.length)
  for (const clock of ['12:41', '13:50']) {
    const s = initialState(ds, ITEMS, { clock })
    const viaDs = pageFor(s, { ds, clock, sources: ['mail'] })
    const viaEvents = pageFor(initialState(ds, ITEMS, { clock, events }), { ds, clock, sources: ['mail'], calendar: events })
    assert.deepEqual(viaEvents, viaDs)
  }
})
