// Day-1 review findings that live in the app (reports/D1-review.md): 2, 3 (app half), 6 (app half), 8.
// Each test here failed on the day-1 code (commit 6614baf) and passes on the day-2 code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDataset } from './helpers.ts'
import { buildItems, validAlts } from '../src/logic/items.ts'
import { initialState, reduce } from '../src/logic/flow.ts'
import { STATIC_ALTS } from '../src/data/static-alts.ts'
import type { AppState, Dataset, Input } from '../src/logic/types.ts'

const ds = loadDataset()
const start = (): AppState => initialState(ds, buildItems(ds, ['mail'], STATIC_ALTS), { clock: '12:41' })
const tap = (index: number, list: string, label: string): Input => ({ type: 'press', index, list, label })
const clone = (): Dataset => JSON.parse(JSON.stringify(ds)) as Dataset

// ---- finding 2: a press is tied to the list and the label it came from ----

test('finding 2: a late press from B\'s list (Other answers, index 1) never counts as Send now on C', () => {
  const b = reduce(start(), tap(0, 'inbox', 'Marco — can you cover Friday 6 am?')).state
  const c = reduce(b, tap(0, 'act', 'Send')).state
  assert.equal(c.screen.kind, 'confirm')
  // the duplicated / late event from B: same index as `Send now`, other list, other label
  const late = reduce(c, tap(1, 'act', 'Other answers'))
  assert.equal(late.effect, 'none')
  assert.equal(late.state, c)
  // the right list but a label that is not `Send now` at that index: refused too
  assert.equal(reduce(c, tap(1, 'ok', 'Back')).effect, 'none')
  // a press with no label at all can never send
  assert.equal(reduce(c, { type: 'press', index: 1 }).effect, 'none')
  // only `Send now` on C's own list sends
  assert.equal(reduce(c, tap(1, 'ok', 'Send now')).effect, 'fake-send')
})

test('finding 2: a press from another screen\'s list is dropped on every screen', () => {
  const a = start()
  assert.equal(reduce(a, tap(0, 'act', 'Send')).state, a)
  const b = reduce(a, tap(0, 'inbox', 'Marco — can you cover Friday 6 am?')).state
  assert.equal(b.screen.kind, 'mail')
  assert.equal(reduce(b, tap(0, 'inbox', 'Marco — can you cover Friday 6 am?')).state, b)
  assert.equal(reduce(b, tap(0, 'ok', 'Back')).state, b)
  const d = reduce(b, tap(1, 'act', 'Other answers')).state
  assert.equal(d.screen.kind, 'alts')
  assert.equal(reduce(d, tap(1, 'act', 'Other answers')).state, d)
})

// ---- finding 3 (app half): no draft or alternative the glasses cannot show, or that hides another text ----

const BAD = [
  'Sure, details at pay.example.com/inv.', // bare domain
  'ｗｗｗ．ｅｘａｍｐｌｅ．ｃｏｍ', // fullwidth (NFKC changes it)
  'Call me on 5145550199 today.', // 6+ digit run
  'Write to ap@example.net.', // address
  "Yes, I'll wire the $4,800 deposit.", // currency
  '**Yes**, see you then.', // markdown
  'Yes‮.enif', // right-to-left override
  'Yes​, fine.', // zero-width space
  'Yes fine.', // line separator
  'Yes\u0085fine.', // NEL
  'Yes\tfine.', // tab
  'Done ✓ see you.', // no G2 glyph for U+2713
]

test('finding 3: validAlts refuses every unsafe alternative', () => {
  for (const bad of BAD) assert.deepEqual(validAlts([bad]), [], JSON.stringify(bad))
  // the four static sets stay whole
  for (const list of Object.values(STATIC_ALTS)) assert.equal(validAlts(list).length, 4)
})

test('finding 3: an unsafe draft never reaches B or C (Send is not offered, Other answers still is)', () => {
  for (const bad of BAD) {
    const d = clone()
    d.mail[0].draft = bad
    const marco = buildItems(d, ['mail'], STATIC_ALTS).find((i) => i.persona === 'marco')
    assert.ok(marco, JSON.stringify(bad))
    assert.equal(marco.draft, '', JSON.stringify(bad))
  }
})

// ---- finding 6 (app half): measured against the screens ----

test('finding 6: a draft over 2 wrapped lines after "Draft: " and an alternative over 552 px are refused', () => {
  const d = clone()
  d.mail[0].draft =
    'Yes, I can cover Friday six am on line one, and I will also bring the new crew list, the keys for the gate and the forms for the safety audit that starts at noon.'
  const marco = buildItems(d, ['mail'], STATIC_ALTS).find((i) => i.persona === 'marco')
  assert.equal(marco?.draft, '')
  assert.deepEqual(validAlts(['WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW']), []) // 50 capitals, too wide
})

// ---- finding 8: a time that is not HH:MM never blanks the glasses ----

test('finding 8: ISO times build, sort newest first across two days, and show as HH:MM', () => {
  const d = clone()
  d.mail[0].at = '2026-11-23T23:50:00-05:00' // yesterday, late
  d.mail[1].at = '2026-11-24T09:00:00-05:00' // today
  const items = buildItems(d, ['mail'], STATIC_ALTS)
  assert.deepEqual(
    items.map((i) => i.persona),
    ['priya', 'marco'],
  )
  d.mail[0].at = 'yesterday'
  assert.doesNotThrow(() => buildItems(d, ['mail'], STATIC_ALTS))
})
