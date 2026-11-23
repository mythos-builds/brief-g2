import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadDataset } from './helpers.ts'
import { buildItems } from '../src/logic/items.ts'
import { initialState, reduce, STATE_ORDER } from '../src/logic/flow.ts'
import { pageFor, type PageContext } from '../src/logic/pages.ts'
import { checkPage, textWidth } from '../src/logic/measure.ts'
import { STATIC_ALTS } from '../src/data/static-alts.ts'
import type { AppState, Input, PageSpec, Source } from '../src/logic/types.ts'

const ds = loadDataset()
const ctxOf = (sources: Source[], clock = '12:41'): PageContext => ({ ds, clock, sources })
const press = (index?: number): Input => ({ type: 'press', index })

/** Every page the app can draw on the static data, both SOURCES settings. */
function allPages(): PageSpec[] {
  const pages: PageSpec[] = []
  for (const sources of [['mail'], ['mail', 'telegram']] as Source[][]) {
    const ctx = ctxOf(sources)
    const s0 = initialState(ds, buildItems(ds, sources, STATIC_ALTS), { clock: '12:41' })
    pages.push(pageFor(s0, ctx))
    s0.items.forEach((_, i) => {
      const b = reduce(s0, press(i)).state
      pages.push(pageFor(b, ctx))
      const d = reduce(b, press(1)).state
      pages.push(pageFor(d, ctx))
      for (let a = 0; a < 4; a++) {
        const b2 = reduce(d, press(a)).state
        pages.push(pageFor(b2, ctx))
        pages.push(pageFor(reduce(b2, press(0)).state, ctx))
      }
      const c = reduce(b, press(0)).state
      pages.push(pageFor(c, ctx))
      pages.push(pageFor(reduce(c, { type: 'press', index: 1, list: 'ok', label: 'Send now' }).state, ctx))
    })
    pages.push(pageFor({ ...s0, items: [] }, ctx))
  }
  const e: AppState = initialState(ds, [], { clock: '13:50' })
  pages.push(pageFor(e, ctxOf(['mail'], '13:50')), pageFor(reduce(e, { type: 'down' }).state, ctxOf(['mail'], '13:50')))
  for (const which of STATE_ORDER) pages.push(pageFor({ items: [], sent: [], screen: { kind: 'state', which } }, ctxOf(['mail'])))
  return pages
}

test('the checker flags a glyph the firmware font lacks (✓ U+2713 draws nothing on G2)', () => {
  const p: PageSpec = { screen: 'X', boxes: [{ kind: 'text', name: 't', x: 0, y: 0, w: 576, h: 288, pad: 4, capture: true, content: 'Sent ✓' }] }
  assert.match(checkPage(p).problems.join(), /U\+2713/)
  assert.ok(textWidth('Sent √') > textWidth('Sent '))
})

test('home header: mail only and with Telegram', () => {
  const a1 = pageFor(initialState(ds, buildItems(ds, ['mail'], STATIC_ALTS), { clock: '12:41' }), ctxOf(['mail']))
  const a2 = pageFor(initialState(ds, buildItems(ds, ['mail', 'telegram'], STATIC_ALTS), { clock: '12:41' }), ctxOf(['mail', 'telegram']))
  const hdr = (p: PageSpec) => (p.boxes[0].kind === 'text' ? p.boxes[0].content : '')
  assert.match(hdr(a1), /^2 need you · 12:41/)
  assert.match(hdr(a2), /^3 need you · 2 mail · 1 TG · 12:41/)
})

test('every page respects the display limits (measured): ≤ 4 text lines, no line over 576 px, ≤ 12 containers, one capture', () => {
  const pages = allPages()
  assert.ok(pages.length > 30)
  const problems = pages.flatMap((p) => checkPage(p).problems.map((x) => `${p.screen}: ${x}`))
  assert.deepEqual(problems, [])
})

test('the checker catches a line that is too wide, too many lines, two captures', () => {
  const bad: PageSpec = {
    screen: 'X',
    boxes: [
      { kind: 'text', name: 't', x: 0, y: 0, w: 576, h: 288, pad: 4, capture: true, content: 'W'.repeat(120) + '\n1\n2\n3\n4' },
      { kind: 'list', name: 'l', x: 0, y: 200, w: 576, h: 80, pad: 0, capture: true, items: ['x'.repeat(70)] },
    ],
  }
  const r = checkPage(bad).problems.join(' | ')
  assert.match(r, /event-capture containers/)
  assert.match(r, /text lines on one screen/)
  assert.match(r, /over 64 characters/)
})
