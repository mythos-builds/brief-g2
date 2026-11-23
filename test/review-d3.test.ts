// D3 review (reports/D3-review.md), finding 2: a stale NAMED list press (Skip pressed twice, or the firmware
// delivering one press twice) must not land on the next item's B page, which has the same list `act` and the same
// rows. Before the fix the second Skip was accepted at once and skipped item 2 for the whole account.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDataset } from './helpers.ts'
import { buildItems } from '../src/logic/items.ts'
import { initialState, reduce } from '../src/logic/flow.ts'
import { pageFor, type PageContext } from '../src/logic/pages.ts'
import { toInput, UNNAMED_PRESS_MIN_MS } from '../src/logic/input.ts'
import { STATIC_ALTS } from '../src/data/static-alts.ts'
import type { AppState, Effect, PageSpec } from '../src/logic/types.ts'

const ds = loadDataset()
const ctx: PageContext = { ds, clock: '12:41', sources: ['mail'] }

function captureRows(page: PageSpec): { name: string; items: string[] } {
  const box = page.boxes.find((b) => b.capture)
  if (!box || box.kind !== 'list') throw new Error('no capture list')
  return { name: box.name, items: box.items }
}

test('D3 finding 2: two named Skip presses on two consecutive B pages give one skip, not two', () => {
  let state: AppState = initialState(ds, buildItems(ds, ['mail'], STATIC_ALTS), { clock: '12:41' })
  assert.ok(state.items.length >= 2)
  // A → B of item 1
  state = reduce(state, { type: 'press', index: 0, list: 'inbox', label: captureRows(pageFor(state, ctx)).items[0] }).state
  assert.equal(state.screen.kind, 'mail')
  const b1 = pageFor(state, ctx)
  const rows = captureRows(b1)
  const skipAt = rows.items.indexOf('Skip')
  const skipEvent = { listEvent: { containerName: rows.name, currentSelectItemName: 'Skip', currentSelectItemIndex: skipAt, eventType: 0 } }
  const effects: Effect[] = []

  // the first Skip, on a page up for a second
  const first = toInput(skipEvent, b1, false, 1000)
  assert.ok(first)
  const s1 = reduce(state, first)
  effects.push(s1.effect)
  state = s1.state
  const b2 = pageFor(state, ctx)
  assert.deepEqual(captureRows(b2), captureRows(b1)) // same list, same rows: the names cannot tell the pages apart

  // the same press again, 40 ms after item 2's page is drawn (render finished: drawing = false)
  const second = toInput(skipEvent, b2, false, 40)
  if (second) effects.push(reduce(state, second).effect)
  assert.deepEqual(effects.filter((e) => e === 'skip'), ['skip'])
})

test('D3 finding 2: every list press, named or not, needs the drawn page up for UNNAMED_PRESS_MIN_MS', () => {
  const C: PageSpec = {
    screen: 'C',
    boxes: [{ kind: 'list', name: 'ok', x: 0, y: 160, w: 576, h: 80, pad: 0, capture: true, items: ['Back', 'Send now'] }],
  }
  const named = { listEvent: { containerName: 'ok', currentSelectItemName: 'Send now', currentSelectItemIndex: 1, eventType: 0 } }
  assert.equal(toInput(named, C, false, 0), undefined)
  assert.equal(toInput(named, C, false, UNNAMED_PRESS_MIN_MS - 1), undefined)
  assert.deepEqual(toInput(named, C, false, UNNAMED_PRESS_MIN_MS), { type: 'press', index: 1, list: 'ok', label: 'Send now' })
  // double-press (the exit dialog) is not delayed
  assert.deepEqual(toInput({ listEvent: { eventType: 3 } }, C, false, 0), { type: 'double' })
})
