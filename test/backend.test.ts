// The backend client (src/data/backend.ts) against a stubbed backend built from BRIEF-D2.md § 3 (test/stub-backend.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDataset } from './helpers.ts'
import { memoryStorage, stubBackend } from './stub-backend.ts'
import { BackendError, choiceFor, createClient, PAIRED_KEY, type FetchLike } from '../src/data/backend.ts'
import { buildItems } from '../src/logic/items.ts'
import { STATIC_ALTS } from '../src/data/static-alts.ts'
import { apiBaseOf, dataSourceOf, DATA_SOURCE, REQUIRE_PAIRING } from '../src/config.ts'
import type { Item } from '../src/logic/types.ts'

const ds = loadDataset()
const ITEMS: Item[] = buildItems(ds, ['mail', 'telegram'], STATIC_ALTS) // 3 items, each with 4 alternatives
const BASE = 'https://brief.appfinishers.com'

function setup(opts: Parameters<typeof stubBackend>[1] = {}, stored: Record<string, string> = {}) {
  const be = stubBackend(ITEMS, opts)
  const storage = memoryStorage(stored)
  const client = createClient({ base: BASE, fetch: be.fetch, storage })
  return { be, storage, client }
}

async function rejectsWith(p: Promise<unknown>, kind: string) {
  await assert.rejects(p, (e: unknown) => e instanceof BackendError && e.kind === kind && e.message === kind)
}

test('defaults: static data, same-origin API, pairing off; the base accepts an origin only', () => {
  assert.equal(DATA_SOURCE, 'static')
  assert.equal(REQUIRE_PAIRING, false)
  assert.equal(dataSourceOf('backend'), 'backend')
  assert.equal(dataSourceOf('anything'), 'static')
  assert.equal(apiBaseOf(undefined), '')
  assert.equal(apiBaseOf('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  assert.equal(apiBaseOf('http://127.0.0.1:8787/x?y'), '')
})

test('start: a demo session, then GET /api/items → the same list as static data (SOURCES filter kept)', async () => {
  const { be, client, storage } = setup()
  assert.equal(await client.start(), 'demo')
  const mail = await client.items(['mail'])
  assert.deepEqual(mail, buildItems(ds, ['mail'], STATIC_ALTS))
  assert.equal(mail.length, 2)
  const all = await client.items(['mail', 'telegram'])
  assert.deepEqual(
    all.map((i) => i.id),
    ['tg-0', 'mail-0', 'mail-1'],
  )
  assert.deepEqual(be.calls[0], { method: 'POST', path: '/api/session', auth: undefined, body: '{"mode":"demo"}' })
  // the token travels in the Authorization header only, never in a URL; a demo session is never stored
  const tok = be.calls[1].auth?.slice('Bearer '.length) ?? ''
  assert.match(tok, /^[A-Za-z0-9_-]{43}$/)
  for (const c of be.calls) assert.ok(!c.path.includes(tok))
  assert.equal(storage.data.size, 0)
})

test('Send now: choice 0 = the draft shown, 1–4 = the alternative picked; Sent only after a 200; then 409 → gone', async () => {
  const { be, client } = setup()
  const items = await client.items(['mail'])
  const marco = items[0]
  assert.deepEqual(await client.send(marco.id, marco.draft), { real: false })
  await rejectsWith(client.send(marco.id, marco.draft), 'gone') // already handled: 409
  const priya = items[1]
  assert.deepEqual(await client.send(priya.id, priya.alts[2]), { real: false })
  assert.deepEqual(be.state.sent, [
    { id: 'mail-0', choice: 0 },
    { id: 'mail-1', choice: 3 },
  ])
  assert.deepEqual(
    be.calls.filter((c) => c.path.endsWith('/send')).map((c) => c.body),
    ['{"choice":0}', '{"choice":0}', '{"choice":3}'], // the second one got the 409
  )
  assert.deepEqual(await client.items(['mail']), [])
})

test('a text that is not the server\'s draft or one of its alternatives is never posted', async () => {
  const { be, client } = setup()
  const [marco] = await client.items(['mail'])
  const before = be.calls.length
  await rejectsWith(client.send(marco.id, 'Something I typed'), 'error')
  await rejectsWith(client.send('mail-99', marco.draft), 'error')
  assert.equal(be.calls.length, before)
  assert.equal(choiceFor(undefined, 'x'), undefined)
  assert.equal(choiceFor(marco, ''), undefined)
})

test('Skip → the skip route with an empty body; the item leaves the list', async () => {
  const { be, client } = setup()
  const [marco] = await client.items(['mail'])
  await client.skip(marco.id)
  const call = be.calls.find((c) => c.path === '/api/items/mail-0/skip')
  assert.equal(call?.body, undefined)
  assert.deepEqual(
    (await client.items(['mail'])).map((i) => i.id),
    ['mail-1'],
  )
  await rejectsWith(client.skip(marco.id), 'gone')
})

test('401 → one new demo session, once', async () => {
  const { be, client } = setup()
  await client.items(['mail'])
  be.expireAll()
  assert.equal((await client.items(['mail'])).length, 2)
  assert.equal(be.calls.filter((c) => c.path === '/api/session').length, 2)
  // a backend that answers 401 to everything: one new session, one retry, then an F state
  const always401: FetchLike = async (url, init) =>
    url.endsWith('/api/session') ? be.fetch(url, init) : { status: 401, json: async () => ({ error: 'unauthorized' }) }
  let sessions = 0
  const counting: FetchLike = async (url, init) => {
    if (url.endsWith('/api/session')) sessions++
    return always401(url, init)
  }
  const c2 = createClient({ base: BASE, fetch: counting, storage: memoryStorage() })
  await rejectsWith(c2.items(['mail']), 'signin')
  assert.equal(sessions, 2) // the start + exactly one renewal
})

test('pairing: a wrong code → gone; the right one → a paired session kept in the SDK storage, used on the next start', async () => {
  const { be, client, storage } = setup({ codes: ['123456'] })
  await rejectsWith(client.claim('000000'), 'gone')
  await rejectsWith(client.claim('12345'), 'gone') // not 6 digits: never posted
  assert.equal(be.calls.filter((c) => c.path === '/api/pair/claim').length, 1)
  await client.claim('123456')
  assert.equal(client.mode(), 'paired')
  assert.match(storage.data.get(PAIRED_KEY) ?? '', /^[A-Za-z0-9_-]{43}$/)
  await rejectsWith(client.claim('123456'), 'gone') // a code works once
  // a new app start (same storage): paired, no demo session asked for
  const c2 = createClient({ base: BASE, fetch: be.fetch, storage })
  const sessionsBefore = be.calls.filter((c) => c.path === '/api/session').length
  assert.equal(await c2.start(), 'paired')
  assert.equal((await c2.items(['mail'])).length, 2)
  assert.equal(be.calls.filter((c) => c.path === '/api/session').length, sessionsBefore)
})

test('a stored paired session that expired is forgotten, and a demo session takes over (once)', async () => {
  const { be, client, storage } = setup({ codes: ['654321'] })
  await client.claim('654321')
  be.expireAll()
  const c2 = createClient({ base: BASE, fetch: be.fetch, storage })
  assert.equal((await c2.items(['mail'])).length, 2)
  assert.equal(c2.mode(), 'demo')
  assert.equal(storage.data.get(PAIRED_KEY), '')
})

test('REQUIRE_PAIRING on and nothing stored → « Sign-in needed », no call', async () => {
  const { be, client } = setup()
  await rejectsWith(client.start(true), 'signin')
  assert.equal(be.calls.length, 0)
})

test('every other failure is a plain F state: offline, daily limit, try later, server error; never the body or the token', async () => {
  const down = setup()
  down.be.state.down = true
  await rejectsWith(down.client.items(['mail']), 'offline')
  const cap = setup({ dailyCap: true })
  await rejectsWith(cap.client.start(), 'limit')
  const s = setup()
  await s.client.items(['mail'])
  s.be.state.serverError = true
  await rejectsWith(s.client.items(['mail']), 'error')
  const limited: FetchLike = async () => ({ status: 429, json: async () => ({ error: 'rate_limited' }) })
  await rejectsWith(createClient({ base: BASE, fetch: limited, storage: memoryStorage() }).start(), 'later')
})

test('a malformed answer is a server error, never shown', async () => {
  const bad: FetchLike = async (url) =>
    url.endsWith('/api/session')
      ? { status: 200, json: async () => ({ session: 'A'.repeat(43), mode: 'demo', expires_in: 7200 }) }
      : { status: 200, json: async () => ({ mode: 'demo', items: [{ ...ITEMS[1], alts: ['only one'] }] }) }
  await rejectsWith(createClient({ base: BASE, fetch: bad, storage: memoryStorage() }).items(['mail']), 'error')
  const shortToken: FetchLike = async () => ({ status: 200, json: async () => ({ session: 'abc', mode: 'demo' }) })
  await rejectsWith(createClient({ base: BASE, fetch: shortToken, storage: memoryStorage() }).start(), 'error')
})

test('finding 3 on server items: an unsafe alternative or draft is not shown, and choices keep the server\'s indexes', async () => {
  const tricky: Item = { ...ITEMS[1], alts: ['Write to ap@example.net.', 'Yes​, fine.', 'No, not today.', 'Later today.'], draft: '**Yes**, see you.' }
  const be = stubBackend([tricky])
  const client = createClient({ base: BASE, fetch: be.fetch, storage: memoryStorage() })
  const [shown] = await client.items(['mail'])
  assert.equal(shown.draft, '')
  assert.deepEqual(shown.alts, ['No, not today.', 'Later today.'])
  await client.send(shown.id, 'Later today.')
  assert.deepEqual(be.state.sent, [{ id: tricky.id, choice: 4 }])
})
