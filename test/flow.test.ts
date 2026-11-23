import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDataset } from './helpers.ts'
import { buildItems } from '../src/logic/items.ts'
import { actItems, altItems, initialState, reduce, STATE_ORDER, type Step } from '../src/logic/flow.ts'
import { STATIC_ALTS } from '../src/data/static-alts.ts'
import type { AppState, Input } from '../src/logic/types.ts'

const ds = loadDataset()
const start = (sources: ('mail' | 'telegram')[] = ['mail'], clock = '12:41'): AppState =>
  initialState(ds, buildItems(ds, sources, STATIC_ALTS), { clock })

function run(state: AppState, inputs: Input[]): { state: AppState; steps: Step[] } {
  const steps: Step[] = []
  for (const i of inputs) {
    const s = reduce(state, i)
    steps.push(s)
    state = s.state
  }
  return { state, steps }
}

const press = (index?: number): Input => ({ type: 'press', index })
// C's `Send now` as the glasses report it (list + label): a press by index alone never sends (review finding 2)
const sendNow: Input = { type: 'press', index: 1, list: 'ok', label: 'Send now' }

test('starts on A at 12:41, on E at 13:50, on F with the states preview', () => {
  assert.equal(start().screen.kind, 'home')
  assert.equal(start(['mail'], '13:50').screen.kind, 'brief')
  assert.equal(initialState(ds, [], { clock: '12:41', states: true }).screen.kind, 'state')
})

test('the whole path: A → B → D″ → B with the picked answer → C → Sent ✓ → next item', () => {
  let s = start()
  s = reduce(s, press(0)).state // A: Marco
  assert.deepEqual(s.screen, { kind: 'mail', id: 'mail-0', draft: 'Yes, I can cover Friday 6 am on line 1.' })
  s = reduce(s, press(1)).state // B: Other answers
  assert.equal(s.screen.kind, 'alts')
  s = reduce(s, press(1)).state // D″: the « No… » line
  assert.deepEqual(s.screen, { kind: 'mail', id: 'mail-0', draft: "No, I can't this Friday. Sorry." })
  s = reduce(s, press(0)).state // B: Send
  assert.deepEqual(s.screen, { kind: 'confirm', id: 'mail-0', draft: "No, I can't this Friday. Sorry." })
  const sent = reduce(s, sendNow) // C: Send now
  assert.equal(sent.effect, 'fake-send')
  assert.equal(sent.state.screen.kind, 'sent')
  assert.deepEqual(sent.state.sent, [{ id: 'mail-0', draft: "No, I can't this Friday. Sorry." }])
  assert.deepEqual(
    sent.state.items.map((i) => i.id),
    ['mail-1'],
  )
  const next = reduce(sent.state, { type: 'tick' }).state
  assert.deepEqual(next.screen, { kind: 'mail', id: 'mail-1', draft: priyaDraft() })
})

function priyaDraft(): string {
  return ds.mail[1].draft ?? ''
}

test('a send always takes two deliberate presses: Send on B, then Send now on C', () => {
  const b = reduce(start(), press(0)).state
  // C's cursor starts on Back: the first press there goes back, it never sends
  const c = reduce(b, press(0)).state
  const firstOnC = reduce(c, press(0))
  assert.equal(firstOnC.effect, 'none')
  assert.equal(firstOnC.state.screen.kind, 'mail')
  // from every screen but C, no single gesture of any kind sends
  const inputs: Input[] = [press(0), press(1), press(2), press(3), press(4), press(), { type: 'up' }, { type: 'down' }, { type: 'double' }, { type: 'tick' }]
  const screens: AppState[] = [start(), b, reduce(b, press(1)).state, start(['mail'], '13:50')]
  for (const s of screens) for (const i of inputs) assert.notEqual(reduce(s, i).effect, 'fake-send', `${s.screen.kind} + ${JSON.stringify(i)}`)
  // and only `Send now` on C does, named by its list and label
  assert.equal(reduce(c, press(1)).effect, 'none')
  assert.equal(reduce(c, sendNow).effect, 'fake-send')
})

test('double-press = the system exit dialog everywhere, the state never changes', () => {
  const b = reduce(start(), press(0)).state
  const all = [start(), b, reduce(b, press(1)).state, reduce(b, press(0)).state, start(['mail'], '13:50'), initialState(ds, [], { clock: '12:41', states: true })]
  const c = reduce(b, press(0)).state
  all.push(reduce(c, sendNow).state) // Sent ✓
  for (const s of all) {
    const r = reduce(s, { type: 'double' })
    assert.equal(r.effect, 'exit-dialog')
    assert.equal(r.state, s)
  }
})

test('Sent ✓ ignores presses; nothing can send twice', () => {
  const c = run(start(), [press(0), press(0)]).state
  const sent = reduce(c, sendNow).state
  for (const i of [press(0), press(1)]) {
    const r = reduce(sent, i)
    assert.equal(r.effect, 'none')
    assert.equal(r.state, sent)
  }
})

test('cursor moves: swipes on list screens change nothing (the firmware moves the cursor)', () => {
  const s = start()
  assert.equal(reduce(s, { type: 'down' }).state, s)
  assert.equal(reduce(s, { type: 'up' }).state, s)
})

test('Skip goes to the next item, then back to A when none is left', () => {
  const r = run(start(), [press(0), press(2), press(2)])
  assert.equal((r.steps[1].state.screen as { id: string }).id, 'mail-1')
  assert.equal(r.state.screen.kind, 'home')
})

test('Back on D″ and on C keeps the draft', () => {
  const b = reduce(start(), press(0)).state
  const d = reduce(b, press(1)).state
  const backFromD = reduce(d, press(altItems(b.items[0]).length - 1)).state
  assert.deepEqual(backFromD.screen, b.screen)
  const c = reduce(b, press(0)).state
  assert.deepEqual(reduce(c, press(0)).state.screen, b.screen)
})

test('Other answers only with at least 2 valid alternatives', () => {
  const items = buildItems(ds, ['mail'], { marco: ['Yes, fine.', 'x'.repeat(80)] })
  assert.deepEqual(actItems(items[0]), ['Send', 'Skip'])
  assert.deepEqual(actItems(buildItems(ds, ['mail'], STATIC_ALTS)[0]), ['Send', 'Other answers', 'Skip'])
  // without Other answers, index 1 is Skip
  const s = initialState(ds, items, { clock: '12:41' })
  const b = reduce(s, press(0)).state
  assert.equal((reduce(b, press(1)).state.screen as { id: string }).id, 'mail-1')
})

test('after the last send, A shows Inbox clear', () => {
  let s = start()
  for (let n = 0; n < 2; n++) {
    s = run(s, [press(0), press(0), sendNow]).state
    s = reduce(s, { type: 'tick' }).state
    if (s.screen.kind === 'mail') s = { ...s, screen: { kind: 'home' } }
  }
  assert.equal(s.items.length, 0)
  assert.equal(s.sent.length, 2)
  assert.equal(s.screen.kind, 'home')
})

test('E: swipe turns the page, press dismisses to A; F: swipe walks the states', () => {
  const e = start(['mail'], '13:50')
  const p2 = reduce(e, { type: 'down' }, 2).state
  assert.deepEqual(p2.screen, { kind: 'brief', page: 1 })
  assert.deepEqual(reduce(p2, { type: 'down' }, 2).state.screen, { kind: 'brief', page: 1 })
  assert.deepEqual(reduce(p2, { type: 'up' }, 2).state.screen, { kind: 'brief', page: 0 })
  assert.equal(reduce(e, press()).state.screen.kind, 'home')
  let f = initialState(ds, [], { clock: '12:41', states: true })
  const seen = []
  for (let n = 0; n < STATE_ORDER.length; n++) {
    seen.push((f.screen as { which: string }).which)
    f = reduce(f, { type: 'down' }).state
  }
  assert.deepEqual(seen, STATE_ORDER)
})
