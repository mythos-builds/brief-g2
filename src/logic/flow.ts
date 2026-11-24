// The screens as a state machine: (state, gesture) → (state, effect). Pure, so `npm test` proves the rules:
// - double-press is the system exit dialog everywhere, never bound to an action;
// - a send = `Send` on B, then `Send now` on C (the cursor starts on `Back`): two deliberate presses on labelled items;
// - nothing is ever sent: `fake-send` only records the reply in memory.
import type { AppState, CalEvent, Dataset, Effect, Input, Item, Screen, StateName } from './types.ts'
import type { BackendError } from '../data/backend.ts'
import { briefDueIn, eventsOf } from './items.ts'

export const ACT_SEND = 'Send'
export const ACT_OTHER = 'Other answers'
export const ACT_SKIP = 'Skip'
export const BACK = 'Back'
export const SEND_NOW = 'Send now'
export const STATE_ORDER: StateName[] = ['signin', 'offline', 'working', 'error', 'later', 'limit', 'sendcap', 'handled', 'unknown']

/** The event-capture list of each screen (its container name): a press from any other list is dropped. */
export const LIST_OF = { home: 'inbox', mail: 'act', alts: 'alts', confirm: 'ok' } as const

/** B's `act` list. `Send` only with a draft that passed the checks; `Other answers` only with ≥ 2 valid alternatives. */
export function actItems(item: Item, draft: string = item.draft): string[] {
  const out = draft ? [ACT_SEND] : []
  if (item.alts.length >= 2) out.push(ACT_OTHER)
  out.push(ACT_SKIP)
  return out
}

/**
 * The row a press acted on, or undefined when the press must be dropped: it names another screen's list, or its
 * label is not the row at its index (a late or duplicated event from the page before; review finding 2).
 */
function picked(rows: readonly string[], input: Extract<Input, { type: 'press' }>, list: string): string | undefined {
  if (input.list !== undefined && input.list !== list) return undefined
  const row = rows[input.index ?? 0]
  if (row === undefined) return undefined
  if (input.label !== undefined && input.label !== row) return undefined
  return row
}

/** D″'s `alts` list: the alternatives, then `Back` (≤ 5 items). */
export function altItems(item: Item): string[] {
  return [...item.alts.slice(0, 4), BACK]
}

/** C's `ok` list, in this order: the cursor starts on `Back`. */
export const CONFIRM_ITEMS = [BACK, SEND_NOW] as const

export function findItem(state: AppState, id: string): Item | undefined {
  return state.items.find((i) => i.id === id)
}

/** `events` = the Worker's calendar (backend mode); absent = the dataset's. `clock` '' = not known: no brief is due. */
export function initialState(ds: Dataset, items: Item[], opts: { clock: string; states?: boolean; events?: CalEvent[] }): AppState {
  let screen: Screen = { kind: 'home' }
  if (opts.states) screen = { kind: 'state', which: STATE_ORDER[0] }
  else if (briefDueIn(opts.events ?? eventsOf(ds), opts.clock) >= 0) screen = { kind: 'brief', page: 0 }
  return { items, sent: [], screen }
}

function openItem(state: AppState, index: number): Screen {
  const item = state.items[index]
  return item ? { kind: 'mail', id: item.id, draft: item.draft } : { kind: 'home' }
}

export interface Step {
  state: AppState
  effect: Effect
}

const stay = (state: AppState): Step => ({ state, effect: 'none' })
const go = (state: AppState, screen: Screen, effect: Effect = 'none'): Step => ({ state: { ...state, screen }, effect })

export function reduce(state: AppState, input: Input, briefPages = 2): Step {
  // Double-press = the system exit dialog on every screen. The state never changes.
  if (input.type === 'double') return { state, effect: 'exit-dialog' }

  const s = state.screen
  switch (s.kind) {
    case 'home': {
      if (input.type !== 'press' || state.items.length === 0) return stay(state)
      // A's rows are fitted (cut) by pages.ts: main.ts matches the label against the drawn page, here only the list
      if (input.list !== undefined && input.list !== LIST_OF.home) return stay(state)
      return go(state, openItem(state, input.index ?? 0))
    }
    case 'mail': {
      const item = findItem(state, s.id)
      if (!item) return go(state, { kind: 'home' })
      if (input.type !== 'press') return stay(state)
      const label = picked(actItems(item, s.draft), input, LIST_OF.mail)
      if (label === ACT_SEND && s.draft) return go(state, { kind: 'confirm', id: item.id, draft: s.draft })
      if (label === ACT_OTHER) return go(state, { kind: 'alts', id: item.id, draft: s.draft })
      if (label === ACT_SKIP) {
        const at = state.items.findIndex((i) => i.id === item.id)
        return go(state, openItem(state, at + 1), 'skip')
      }
      return stay(state)
    }
    case 'alts': {
      const item = findItem(state, s.id)
      if (!item) return go(state, { kind: 'home' })
      if (input.type !== 'press') return stay(state)
      const label = picked(altItems(item), input, LIST_OF.alts)
      if (label === undefined) return stay(state)
      if (label === BACK) return go(state, { kind: 'mail', id: item.id, draft: s.draft })
      return go(state, { kind: 'mail', id: item.id, draft: label })
    }
    case 'confirm': {
      const item = findItem(state, s.id)
      if (!item) return go(state, { kind: 'home' })
      if (input.type !== 'press') return stay(state)
      const label = picked(CONFIRM_ITEMS, input, LIST_OF.confirm)
      if (label === BACK) return go(state, { kind: 'mail', id: item.id, draft: s.draft })
      // the only path to a send: `Send now`, on C's own list, with its label (input.ts ties both to the page drawn now)
      if (label === SEND_NOW && input.list === LIST_OF.confirm && input.label === SEND_NOW) {
        const at = state.items.findIndex((i) => i.id === item.id)
        const items = state.items.filter((i) => i.id !== item.id)
        const next: AppState = { items, sent: [...state.sent, { id: item.id, draft: s.draft }], screen: state.screen }
        return go(next, { kind: 'sent', id: item.id, source: item.source, nextIndex: at, real: false }, 'fake-send')
      }
      return stay(state)
    }
    case 'sent': {
      // `Sent ✓` for 2 s, then the next item (or A). A press does nothing here: no gesture can send twice.
      if (input.type !== 'tick') return stay(state)
      return go(state, openItem(state, s.nextIndex))
    }
    case 'brief': {
      if (input.type === 'press') return go(state, { kind: 'home' })
      if (input.type === 'down') return go(state, { kind: 'brief', page: Math.min(s.page + 1, briefPages - 1) })
      if (input.type === 'up') return go(state, { kind: 'brief', page: Math.max(s.page - 1, 0) })
      return stay(state)
    }
    case 'state': {
      // F: press goes home and asks for a reload (backend mode); swipe walks the states (static preview only).
      const at = STATE_ORDER.indexOf(s.which)
      // `Not confirmed`: a press goes on to the next item (this one was already taken out of the list)
      if (s.which === 'unknown' && s.nextIndex !== undefined && input.type === 'press') return go(state, openItem(state, s.nextIndex))
      // `Already handled.`: after 2 s (main.ts' timer) or a press, the list is read again
      if (s.which === 'handled' && input.type === 'tick') return go(state, { kind: 'home' }, 'reload')
      if (input.type === 'press') return go(state, { kind: 'home' }, 'reload')
      if (input.type === 'down') return go(state, { kind: 'state', which: STATE_ORDER[Math.min(at + 1, STATE_ORDER.length - 1)] })
      if (input.type === 'up') return go(state, { kind: 'state', which: STATE_ORDER[Math.max(at - 1, 0)] })
      return stay(state)
    }
  }
}

/**
 * Backend mode, `Send now` answered something else than 200 (BRIEF-D4.md § 3.11). `before` = the state on C, `kind` =
 * the client's BackendError kind. Pure, so a test proves each one. `undefined` = the list must be read again (404).
 * - `failed` (502 `send_failed`, nothing left): the same C page stays, with `Not sent. Send now to try again.`; `Send now`
 *   then posts the same choice again (C keeps the same text, and the choice is the index of that text);
 * - `unknown` (504, it may have left): `Not confirmed. Check Sent on your phone.`; the item leaves the list here, and
 *   a press opens the next one;
 * - `handled` (409): `Already handled.`, then the list is read again; `sendcap` (429 `daily_cap`): its own line;
 * - anything else: the F state of that kind, as before. `Sent` is never shown here: only a 200 shows it.
 */
export function afterSendFailure(before: AppState, kind: BackendError['kind']): AppState | undefined {
  const s = before.screen
  if (s.kind !== 'confirm') return before
  if (kind === 'gone') return undefined
  if (kind === 'failed') return { ...before, screen: { kind: 'confirm', id: s.id, draft: s.draft, failed: true } }
  if (kind === 'unknown') {
    const at = before.items.findIndex((i) => i.id === s.id)
    return { ...before, items: before.items.filter((i) => i.id !== s.id), screen: { kind: 'state', which: 'unknown', nextIndex: Math.max(at, 0) } }
  }
  return { ...before, screen: { kind: 'state', which: kind } }
}

/** Backend mode, `Skip` refused: 409 `already_handled` → `Already handled.` (then the list is read again); 404 → the
 * item leaves the list as a skip would; anything else → its F state. */
export function afterSkipFailure(skipped: AppState, id: string, kind: BackendError['kind']): AppState {
  if (kind === 'gone') return { ...skipped, items: skipped.items.filter((i) => i.id !== id) }
  const which: StateName = kind === 'failed' || kind === 'unknown' ? 'error' : kind
  return { ...skipped, screen: { kind: 'state', which } }
}
