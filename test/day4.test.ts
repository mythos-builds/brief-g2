// BRIEF-D4.md § 4: the words of § 3.11 (one test per state, each measured), « Other answers » end to end (the index
// posted for the draft and for each of the four lines, and again after `send_failed`), « Disconnect » with the logout
// call, the device clock when the calendar fails, and the dev-only pairing's logic (the build check: dev-pair-build.test.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadDataset } from './helpers.ts'
import { memoryStorage, stubBackend, STUB_ACCOUNT } from './stub-backend.ts'
import { BackendError, createClient, failureOf, PAIRED_KEY, type FetchLike } from '../src/data/backend.ts'
import { buildItems, localClock } from '../src/logic/items.ts'
import { ACT_OTHER, ACT_SEND, afterSendFailure, afterSkipFailure, altItems, initialState, reduce, SEND_NOW } from '../src/logic/flow.ts'
import { DEMO_SENT_LINE, DEMO_SENT_LINE_TG, NOT_SENT_LINE, pageFor, STATE_TEXT, type PageContext } from '../src/logic/pages.ts'
import { checkPage, wrap, SCREEN_W } from '../src/logic/measure.ts'
import { backendHostOf, CONNECT_ADDRESS, DEFAULT_HOST } from '../src/config.ts'
import { devPair, pairCodeOf, withoutPair, DEV_PAIR_MARKER } from '../src/dev-pair.ts'
import { STATIC_ALTS } from '../src/data/static-alts.ts'
import type { AppState, Item, StateName, TextBox } from '../src/logic/types.ts'

const ds = loadDataset()
const ITEMS: Item[] = buildItems(ds, ['mail'], STATIC_ALTS)
const BASE = 'https://brief.appfinishers.com'
const ctx: PageContext = { ds, clock: '12:41', sources: ['mail'], calendar: [] }
const CODE = '123456'

async function rejectsWith(p: Promise<unknown>, kind: string) {
  await assert.rejects(p, (e: unknown) => e instanceof BackendError && e.kind === kind)
}

async function paired(setup?: (be: ReturnType<typeof stubBackend>) => void) {
  const be = stubBackend(ITEMS, { codes: [CODE] })
  setup?.(be)
  const storage = memoryStorage()
  const client = createClient({ base: BASE, fetch: be.fetch, storage, logoutMs: 50 })
  await client.claim(CODE)
  const items = await client.items(['mail'])
  return { be, storage, client, items }
}

const content = (s: AppState) => pageFor(s, ctx).boxes.map((b) => (b.kind === 'text' ? b.content : b.items.join('|'))).join('\n')

function fits(s: AppState) {
  const page = pageFor(s, ctx)
  assert.deepEqual(checkPage(page).problems, [], `${page.screen} must fit its containers`)
  return page
}

// ---------- 4.1: the words of § 3.11, one test per state, each measured ----------

test('3.11 Sent, "real":true → the Sent state as today; "real":false → plus `Demo: no real mail was sent`', () => {
  const base: AppState = { items: ITEMS, sent: [], screen: { kind: 'sent', id: ITEMS[0].id, source: 'mail', nextIndex: 0, real: true } }
  assert.equal(content(base), 'Sent √')
  fits(base)
  const demo: AppState = { ...base, screen: { ...base.screen, real: false } as AppState['screen'] }
  assert.equal(content(demo), `Sent √\n${DEMO_SENT_LINE}`)
  assert.equal(DEMO_SENT_LINE, 'Demo: no real mail was sent')
  fits(demo)
  // a Telegram message is not a mail: its own demo line
  const tg: AppState = { ...base, screen: { ...base.screen, source: 'telegram', real: false } as AppState['screen'] }
  assert.equal(content(tg), `Sent on Telegram √\n${DEMO_SENT_LINE_TG}`)
  assert.equal(DEMO_SENT_LINE_TG, 'Demo: no real message was sent')
  fits(tg)
})

test('3.11 static mode: `Send now` gives the Sent state with the demo line (nothing leaves)', () => {
  let s = initialState(ds, ITEMS, { clock: '12:41' })
  s = { ...s, screen: { kind: 'confirm', id: ITEMS[0].id, draft: ITEMS[0].draft } }
  const step = reduce(s, { type: 'press', index: 1, list: 'ok', label: SEND_NOW })
  assert.equal(step.effect, 'fake-send')
  assert.equal(content(step.state), `Sent √\n${DEMO_SENT_LINE}`)
})

test('3.11 send_failed → C stays with `Not sent. Send now to try again.`; the draft and the list are kept', () => {
  const item = ITEMS[0]
  const before: AppState = { items: ITEMS, sent: [], screen: { kind: 'confirm', id: item.id, draft: item.draft } }
  const after = afterSendFailure(before, 'failed') as AppState
  assert.deepEqual(after.screen, { kind: 'confirm', id: item.id, draft: item.draft, failed: true })
  assert.equal(after.items, ITEMS)
  const page = fits(after)
  assert.equal(page.screen, 'C')
  const text = (page.boxes[0] as TextBox).content
  assert.equal(NOT_SENT_LINE, 'Not sent. Send now to try again.')
  assert.equal(text, [`To: ${item.fullName}`, NOT_SENT_LINE, item.draft].join('\n'))
  // `Send now` on that page sends again (fake-send effect, same text)
  const again = reduce(after, { type: 'press', index: 1, list: 'ok', label: SEND_NOW })
  assert.equal(again.effect, 'fake-send')
  assert.deepEqual(again.state.sent, [{ id: item.id, draft: item.draft }])
})

test('3.11 send_unknown → `Not confirmed. Check Sent on your phone.`; the item leaves; a press opens the next one', () => {
  const [a, b] = ITEMS
  const before: AppState = { items: ITEMS, sent: [], screen: { kind: 'confirm', id: a.id, draft: a.draft } }
  const after = afterSendFailure(before, 'unknown') as AppState
  assert.equal(content(after), 'Not confirmed. Check Sent on your phone.')
  fits(after)
  assert.ok(!after.items.some((i) => i.id === a.id), 'never offered again')
  const step = reduce(after, { type: 'press' })
  assert.equal(step.effect, 'none') // not a reload: the next item, here
  assert.deepEqual(step.state.screen, { kind: 'mail', id: b.id, draft: b.draft })
})

test('3.11 daily_cap on a send → `Daily send limit reached. Try tomorrow.`', () => {
  const before: AppState = { items: ITEMS, sent: [], screen: { kind: 'confirm', id: ITEMS[0].id, draft: ITEMS[0].draft } }
  const after = afterSendFailure(before, 'sendcap') as AppState
  assert.equal(content(after), 'Daily send limit reached. Try tomorrow.')
  fits(after)
  assert.equal(failureOf(429, 'daily_cap', 'send'), 'sendcap')
  assert.equal(failureOf(429, 'daily_cap'), 'limit') // the demo session's own cap is unchanged
})

test('3.11 already_handled on a send or a skip → `Already handled.`, then the list is read again (tick or press)', () => {
  const before: AppState = { items: ITEMS, sent: [], screen: { kind: 'confirm', id: ITEMS[0].id, draft: ITEMS[0].draft } }
  const sent = afterSendFailure(before, 'handled') as AppState
  assert.equal(content(sent), 'Already handled.')
  fits(sent)
  assert.equal(sent.screen.kind, 'state') // never `Sent` without a 200
  assert.equal(reduce(sent, { type: 'tick' }).effect, 'reload')
  assert.equal(reduce(sent, { type: 'press' }).effect, 'reload')
  const skipped = afterSkipFailure({ ...before, screen: { kind: 'home' } }, ITEMS[0].id, 'handled')
  assert.equal(content(skipped), 'Already handled.')
  assert.equal(afterSendFailure(before, 'gone'), undefined) // 404: the list is read again at once
})

test('3.11 signin_needed → three lines, the host from src/config.ts; no second hard-coded host in src/', () => {
  const s: AppState = { items: [], sent: [], screen: { kind: 'state', which: 'signin' } }
  const text = content(s)
  assert.equal(text, `Sign-in needed\n1. On your phone, open ${DEFAULT_HOST}/connect\n2. Type the 6-digit code in the Even app, on Brief's page`)
  assert.equal(CONNECT_ADDRESS, `${DEFAULT_HOST}/connect`)
  const page = fits(s)
  assert.ok(wrap(text, SCREEN_W - 8).lineCount <= 4)
  assert.equal(backendHostOf('http://127.0.0.1:8787'), '127.0.0.1:8787')
  assert.equal(backendHostOf(''), DEFAULT_HOST)
  assert.equal(page.screen, 'F')
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name)
      if (f.isDirectory()) walk(p)
      else if (/\.(ts|html)$/.test(f.name) && readFileSync(p, 'utf8').includes(DEFAULT_HOST)) hits.push(p)
    }
  }
  walk('src')
  if (readFileSync('index.html', 'utf8').includes(DEFAULT_HOST)) hits.push('index.html')
  assert.deepEqual(hits, [join('src', 'config.ts')])
})

test('3.11 every F state (old and new) fits its container', () => {
  for (const which of Object.keys(STATE_TEXT) as StateName[]) fits({ items: [], sent: [], screen: { kind: 'state', which } })
})

test('3.11 a failed calendar call → the header keeps the device clock (local HH:MM, fake date) and has no `next`', () => {
  const clock = localClock(new Date(2026, 10, 23, 7, 5))
  assert.equal(clock, '07:05')
  const s = initialState(ds, ITEMS, { clock, events: [] })
  const hdr = (pageFor(s, { ...ctx, clock, calendar: [] }).boxes[0] as TextBox).content
  assert.equal(hdr, '2 need you · 07:05')
})

// ---------- the client against the stub of § 3 ----------

test('§ 3.2 f: REAL_SEND not exactly "on" (absent, "off", "ON", "true") → "real":false; "on" → "real":true', async () => {
  for (const v of ['off', 'ON', 'true', '']) {
    const { client, items } = await paired((be) => (be.state.realSend = v))
    assert.deepEqual(await client.send(items[0].id, items[0].draft), { real: false })
  }
  const { client, items } = await paired((be) => (be.state.realSend = 'on'))
  assert.deepEqual(await client.send(items[0].id, items[0].draft), { real: true })
})

test('§ 3.4 send outcomes through the client: 502 → failed (offered again) · 504 → unknown (gone) · cap → sendcap · 409 → handled', async () => {
  const { be, client, items } = await paired((b) => Object.assign(b.state, { realSend: 'on', sendOutcome: 'failed' }))
  await rejectsWith(client.send(items[0].id, items[0].draft), 'failed')
  assert.ok((await client.items(['mail'])).some((i) => i.id === items[0].id), 'send_failed: the item is offered again')
  be.state.sendOutcome = 'unknown'
  await rejectsWith(client.send(items[0].id, items[0].draft), 'unknown')
  await rejectsWith(client.send(items[0].id, items[0].draft), 'handled') // a second press: 409, never a second send
  assert.ok(!(await client.items(['mail'])).some((i) => i.id === items[0].id), 'send_unknown: never offered again')
  be.state.sendOutcome = 'ok'
  be.state.sendDailyCap = 2 // two claims counted already (the failed one is never given back)
  await rejectsWith(client.send(items[1].id, items[1].draft), 'sendcap')
  assert.equal(failureOf(500, undefined, 'send'), 'unknown') // any other 5xx on a send may have left
  assert.equal(failureOf(502, 'bad_gateway', 'send'), 'unknown')
  assert.equal(failureOf(500, undefined), 'error')
})

// ---------- 4.2: « Other answers » end to end: the index posted ----------

/** B → (Other answers → line n → B) → Send → C → Send now; returns the state on C and the press on `Send now`. */
function walkTo(item: Item, n: number): AppState {
  let s: AppState = { items: [item], sent: [], screen: { kind: 'mail', id: item.id, draft: item.draft } }
  if (n > 0) {
    s = reduce(s, { type: 'press', index: 1, list: 'act', label: ACT_OTHER }).state
    assert.equal(s.screen.kind, 'alts')
    const line = altItems(item)[n - 1]
    s = reduce(s, { type: 'press', index: n - 1, list: 'alts', label: line }).state
    assert.deepEqual(s.screen, { kind: 'mail', id: item.id, draft: line })
  }
  s = reduce(s, { type: 'press', index: 0, list: 'act', label: ACT_SEND }).state
  assert.equal(s.screen.kind, 'confirm')
  return s
}

test('4.2 `Send now` posts THAT choice: 0 for the draft, 1–4 for each line; the retry after send_failed posts it again', async () => {
  for (const n of [0, 1, 2, 3, 4]) {
    const { be, client, items } = await paired((b) => Object.assign(b.state, { realSend: 'on', sendOutcome: 'failed' }))
    const item = items[0]
    const onC = walkTo(item, n)
    const press = reduce(onC, { type: 'press', index: 1, list: 'ok', label: SEND_NOW })
    assert.equal(press.effect, 'fake-send')
    const shown = (onC.screen as { draft: string }).draft
    // what main.ts does: client.send(id, C's text) → 502 → afterSendFailure → C again → `Send now` → the same text
    await rejectsWith(client.send(item.id, shown), 'failed')
    const again = afterSendFailure(onC, 'failed') as AppState
    const press2 = reduce(again, { type: 'press', index: 1, list: 'ok', label: SEND_NOW })
    assert.equal(press2.effect, 'fake-send')
    be.state.sendOutcome = 'ok'
    assert.deepEqual(await client.send(item.id, (again.screen as { draft: string }).draft), { real: true })
    const posted = be.calls.filter((c) => c.path.endsWith('/send')).map((c) => c.body)
    assert.deepEqual(posted, [JSON.stringify({ choice: n }), JSON.stringify({ choice: n })], `choice ${n}`)
    assert.deepEqual(be.state.sent, [{ id: item.id, choice: n }])
  }
})

// ---------- 4.3: « Disconnect » ----------

test('4.3 Disconnect: POST /api/session/logout with the paired Bearer, then the token is forgotten; the session is dead', async () => {
  const { be, client, storage } = await paired()
  const token = storage.data.get(PAIRED_KEY) as string
  assert.equal(be.sessionCount(), 1)
  await client.disconnect()
  const call = be.calls.at(-1)
  assert.deepEqual([call?.method, call?.path, call?.auth, call?.body], ['POST', '/api/session/logout', `Bearer ${token}`, undefined])
  assert.equal(be.sessionCount(), 0, 'the server deleted the session')
  assert.equal(storage.data.get(PAIRED_KEY), '')
  assert.equal(client.mode(), undefined)
  // the same token again → 401 (§ 3.8)
  const r = await be.fetch(`${BASE}/api/session/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  assert.equal(r.status, 401)
})

test('4.3 Disconnect: a failing, an offline or a hanging logout is ignored; the token is forgotten anyway (≤ logoutMs)', async () => {
  for (const mode of ['500', 'offline', 'hang'] as const) {
    const { be, storage } = await paired()
    const base = be.fetch
    let aborted = false
    const fetch: FetchLike = async (url, init) => {
      if (!url.endsWith('/api/session/logout')) return base(url, init)
      if (mode === '500') return { status: 500, json: async () => ({ error: 'server_error' }) }
      if (mode === 'offline') throw new TypeError('Failed to fetch')
      init.signal?.addEventListener('abort', () => (aborted = true))
      return new Promise(() => {}) // never answers
    }
    const c = createClient({ base: BASE, fetch, storage, logoutMs: 50 })
    await c.start()
    assert.equal(c.mode(), 'paired')
    const t0 = Date.now()
    await c.disconnect()
    assert.ok(Date.now() - t0 < 1000)
    assert.equal(storage.data.get(PAIRED_KEY), '', mode)
    assert.equal(c.mode(), undefined)
    if (mode === 'hang') assert.ok(aborted, 'the hanging call is aborted')
  }
})

test('4.3 Disconnect on a demo session posts nothing', async () => {
  const be = stubBackend(ITEMS)
  const c = createClient({ base: BASE, fetch: be.fetch, storage: memoryStorage() })
  await c.start()
  const n = be.calls.length
  await c.disconnect()
  assert.equal(be.calls.length, n)
})

// ---------- 4.4: the dev-only pairing's logic ----------

test('3.12 dev pairing: `?pair=<6 digits>` is claimed through /api/pair/claim, stored like a typed code, then removed', async () => {
  assert.equal(DEV_PAIR_MARKER, 'DEV-PAIR-ONLY')
  assert.equal(pairCodeOf('?pair=123456'), '123456')
  assert.equal(pairCodeOf('?pair=12345'), undefined)
  assert.equal(pairCodeOf('?pair=1234567'), undefined)
  assert.equal(withoutPair('http://127.0.0.1:5174/?pair=123456&sources=mail#x'), 'http://127.0.0.1:5174/?sources=mail#x')
  const be = stubBackend(ITEMS, { codes: [CODE] })
  const storage = memoryStorage()
  const client = createClient({ base: BASE, fetch: be.fetch, storage })
  const replaced: string[] = []
  const r = await devPair({ href: `http://127.0.0.1:5174/?pair=${CODE}`, claim: (c) => client.claim(c), replace: (h) => replaced.push(h) })
  assert.equal(r, 'paired')
  assert.deepEqual(replaced, ['http://127.0.0.1:5174/'])
  assert.match(storage.data.get(PAIRED_KEY) ?? '', /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(be.calls.map((c) => `${c.method} ${c.path}`), ['POST /api/pair/claim'])
  // a fresh client on the same storage starts paired (what a restart does)
  const again = createClient({ base: BASE, fetch: be.fetch, storage })
  assert.equal(await again.start(), 'paired')
  assert.equal(STUB_ACCOUNT, 'acct-1')
})

test('3.12 dev pairing: no parameter → nothing; a bad or used code → failed, and the parameter is removed anyway', async () => {
  const be = stubBackend(ITEMS, { codes: [] })
  const client = createClient({ base: BASE, fetch: be.fetch, storage: memoryStorage() })
  const replaced: string[] = []
  const deps = (href: string) => ({ href, claim: (c: string) => client.claim(c), replace: (h: string) => replaced.push(h) })
  assert.equal(await devPair(deps('http://127.0.0.1:5174/?sources=mail')), 'none')
  assert.deepEqual(replaced, [])
  assert.equal(await devPair(deps('http://127.0.0.1:5174/?pair=999999')), 'failed')
  assert.equal(await devPair(deps('http://127.0.0.1:5174/?pair=abc')), 'failed')
  assert.deepEqual(replaced, ['http://127.0.0.1:5174/', 'http://127.0.0.1:5174/'])
})
