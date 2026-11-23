// Review finding 2, the glue half: an SDK event is tied to the page drawn now, and dropped while a page is in flight.
// (On the day-1 code this mapping lived in main.ts, ignored containerName / currentSelectItemName and had no
// in-flight guard; src/logic/input.ts did not exist.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toInput, sideSignal, UNNAMED_PRESS_MIN_MS } from '../src/logic/input.ts'
import type { PageSpec } from '../src/logic/types.ts'

const C: PageSpec = {
  screen: 'C',
  boxes: [
    { kind: 'text', name: 'who', x: 0, y: 0, w: 576, h: 148, pad: 4, capture: false, content: 'To: Marco Bellini' },
    { kind: 'list', name: 'ok', x: 0, y: 160, w: 576, h: 80, pad: 0, capture: true, items: ['Back', 'Send now'] },
  ],
}
const UP = 1000 // ms the page has been drawn
const F: PageSpec = { screen: 'F', boxes: [{ kind: 'text', name: 'state', x: 0, y: 0, w: 576, h: 288, pad: 4, capture: true, content: 'Working…' }] }
const list = (containerName: string | undefined, currentSelectItemName: string | undefined, currentSelectItemIndex: number) => ({
  listEvent: { containerName, currentSelectItemName, currentSelectItemIndex, eventType: 0 },
})

test('a list press carries the drawn list and row; Send now only from C\'s own list', () => {
  assert.deepEqual(toInput(list('ok', 'Send now', 1), C, false, UP), { type: 'press', index: 1, list: 'ok', label: 'Send now' })
  // D3 review, finding 2: a named press also waits for the page to be up 300 ms (two B pages share list and rows)
  assert.equal(toInput(list('ok', 'Send now', 1), C, false, 0), undefined)
  // no name in the event, page up ≥ 300 ms: the row is read from the page drawn now (Send now still works)
  assert.deepEqual(toInput(list(undefined, undefined, 1), C, false, UP), { type: 'press', index: 1, list: 'ok', label: 'Send now' })
})

test('review note 10 / D3 4.1b: an event with only an index lands only on a page up for ≥ 300 ms and not being drawn', () => {
  assert.equal(UNNAMED_PRESS_MIN_MS, 300)
  // the SDK may send only the index (all List_ItemEvent fields are optional; protobuf drops index 0)
  const indexOnly = { listEvent: { currentSelectItemIndex: 1 } }
  assert.equal(toInput(indexOnly, C, false, 0), undefined)
  assert.equal(toInput(indexOnly, C, false, 299), undefined)
  assert.equal(toInput(indexOnly, C, true, 5000), undefined) // a render in flight
  assert.deepEqual(toInput(indexOnly, C, false, 300), { type: 'press', index: 1, list: 'ok', label: 'Send now' })
  // index 0 omitted by protobuf → row 0 (Back)
  assert.deepEqual(toInput({ listEvent: {} }, C, false, 300), { type: 'press', index: 0, list: 'ok', label: 'Back' })
  // half-named events need the 300 ms too; a name that is there must still match
  assert.equal(toInput(list('ok', undefined, 1), C, false, 100), undefined)
  assert.equal(toInput(list(undefined, 'Send now', 1), C, false, 100), undefined)
  assert.deepEqual(toInput(list('ok', undefined, 1), C, false, 400), { type: 'press', index: 1, list: 'ok', label: 'Send now' })
  assert.equal(toInput(list('act', undefined, 1), C, false, 400), undefined) // names B's list: dropped at any age
  assert.equal(toInput(list(undefined, 'Other answers', 1), C, false, 400), undefined)
  assert.equal(toInput(indexOnly, C, false, Number.NaN), undefined) // no draw time known → dropped
})

test('a press from B\'s list (late or duplicated) is dropped on C', () => {
  assert.equal(toInput(list('act', 'Other answers', 1), C, false, UP), undefined)
  assert.equal(toInput(list('ok', 'Other answers', 1), C, false, UP), undefined)
  assert.equal(toInput(list('ok', 'Send now', 5), C, false, UP), undefined)
})

test('every press and swipe is dropped while a page is being drawn; double-press stays the exit dialog', () => {
  assert.equal(toInput(list('ok', 'Send now', 1), C, true, UP), undefined)
  assert.equal(toInput({ textEvent: { eventType: 2 } }, F, true, UP), undefined)
  assert.equal(toInput({ sysEvent: { eventType: 0 } }, F, true, UP), undefined)
  assert.deepEqual(toInput({ sysEvent: { eventType: 3 } }, F, true, UP), { type: 'double' })
  assert.deepEqual(toInput({ listEvent: { eventType: 3 } }, C, true, UP), { type: 'double' })
  assert.equal(toInput(list('ok', 'Send now', 1), undefined, false, UP), undefined) // nothing drawn yet
})

test('a sys press is a press only on a page without a list; background events are a side signal', () => {
  assert.deepEqual(toInput({ sysEvent: { eventType: 0 } }, F, false, UP), { type: 'press' })
  assert.equal(toInput({ sysEvent: { eventType: 0 } }, C, false, UP), undefined)
  assert.equal(sideSignal({ sysEvent: { eventType: 6 } }), 'background')
  assert.equal(sideSignal({ sysEvent: { eventType: 0 } }), undefined)
  // OsEventTypeList (SDK index.d.ts): 5 FOREGROUND_EXIT → background, 4 FOREGROUND_ENTER → back
  assert.equal(sideSignal({ sysEvent: { eventType: 5 } }), 'background')
  assert.equal(sideSignal({ sysEvent: { eventType: 7 } }), 'background')
  assert.equal(sideSignal({ sysEvent: { eventType: 4 } }), 'foreground')
  assert.equal(sideSignal({ listEvent: { eventType: 0 } }), undefined)
})
