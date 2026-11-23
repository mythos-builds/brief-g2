// Review finding 2, the glue half: an SDK event is tied to the page drawn now, and dropped while a page is in flight.
// (On the day-1 code this mapping lived in main.ts, ignored containerName / currentSelectItemName and had no
// in-flight guard; src/logic/input.ts did not exist.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toInput, sideSignal } from '../src/logic/input.ts'
import type { PageSpec } from '../src/logic/types.ts'

const C: PageSpec = {
  screen: 'C',
  boxes: [
    { kind: 'text', name: 'who', x: 0, y: 0, w: 576, h: 148, pad: 4, capture: false, content: 'To: Marco Bellini' },
    { kind: 'list', name: 'ok', x: 0, y: 160, w: 576, h: 80, pad: 0, capture: true, items: ['Back', 'Send now'] },
  ],
}
const F: PageSpec = { screen: 'F', boxes: [{ kind: 'text', name: 'state', x: 0, y: 0, w: 576, h: 288, pad: 4, capture: true, content: 'Working…' }] }
const list = (containerName: string | undefined, currentSelectItemName: string | undefined, currentSelectItemIndex: number) => ({
  listEvent: { containerName, currentSelectItemName, currentSelectItemIndex, eventType: 0 },
})

test('a list press carries the drawn list and row; Send now only from C\'s own list', () => {
  assert.deepEqual(toInput(list('ok', 'Send now', 1), C, false), { type: 'press', index: 1, list: 'ok', label: 'Send now' })
  // no name in the event: the row is read from the page drawn now
  assert.deepEqual(toInput(list(undefined, undefined, 1), C, false), { type: 'press', index: 1, list: 'ok', label: 'Send now' })
})

test('a press from B\'s list (late or duplicated) is dropped on C', () => {
  assert.equal(toInput(list('act', 'Other answers', 1), C, false), undefined)
  assert.equal(toInput(list('ok', 'Other answers', 1), C, false), undefined)
  assert.equal(toInput(list('ok', 'Send now', 5), C, false), undefined)
})

test('every press and swipe is dropped while a page is being drawn; double-press stays the exit dialog', () => {
  assert.equal(toInput(list('ok', 'Send now', 1), C, true), undefined)
  assert.equal(toInput({ textEvent: { eventType: 2 } }, F, true), undefined)
  assert.equal(toInput({ sysEvent: { eventType: 0 } }, F, true), undefined)
  assert.deepEqual(toInput({ sysEvent: { eventType: 3 } }, F, true), { type: 'double' })
  assert.deepEqual(toInput({ listEvent: { eventType: 3 } }, C, true), { type: 'double' })
  assert.equal(toInput(list('ok', 'Send now', 1), undefined, false), undefined) // nothing drawn yet
})

test('a sys press is a press only on a page without a list; background events are a side signal', () => {
  assert.deepEqual(toInput({ sysEvent: { eventType: 0 } }, F, false), { type: 'press' })
  assert.equal(toInput({ sysEvent: { eventType: 0 } }, C, false), undefined)
  assert.equal(sideSignal({ sysEvent: { eventType: 6 } }), 'background')
  assert.equal(sideSignal({ sysEvent: { eventType: 0 } }), undefined)
})
