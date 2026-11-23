// The screens as a state machine: (state, gesture) → (state, effect). Pure, so `npm test` proves the rules:
// - double-press is the system exit dialog everywhere, never bound to an action;
// - a send = `Send` on B, then `Send now` on C (the cursor starts on `Back`): two deliberate presses on labelled items;
// - nothing is ever sent: `fake-send` only records the reply in memory.
import type { AppState, Dataset, Effect, Input, Item, Screen, StateName } from './types.ts'
import { briefDue } from './items.ts'

export const ACT_SEND = 'Send'
export const ACT_OTHER = 'Other answers'
export const ACT_SKIP = 'Skip'
export const BACK = 'Back'
export const SEND_NOW = 'Send now'
export const STATE_ORDER: StateName[] = ['signin', 'offline', 'working', 'error']

/** B's `act` list. `Other answers` only when at least 2 valid alternatives exist. */
export function actItems(item: Item): string[] {
  return item.alts.length >= 2 ? [ACT_SEND, ACT_OTHER, ACT_SKIP] : [ACT_SEND, ACT_SKIP]
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

export function initialState(ds: Dataset, items: Item[], opts: { clock: string; states?: boolean }): AppState {
  let screen: Screen = { kind: 'home' }
  if (opts.states) screen = { kind: 'state', which: STATE_ORDER[0] }
  else if (briefDue(ds, opts.clock) >= 0) screen = { kind: 'brief', page: 0 }
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
      return go(state, openItem(state, input.index ?? 0))
    }
    case 'mail': {
      const item = findItem(state, s.id)
      if (!item) return go(state, { kind: 'home' })
      if (input.type !== 'press') return stay(state)
      const label = actItems(item)[input.index ?? 0]
      if (label === ACT_SEND) return go(state, { kind: 'confirm', id: item.id, draft: s.draft })
      if (label === ACT_OTHER) return go(state, { kind: 'alts', id: item.id, draft: s.draft })
      if (label === ACT_SKIP) {
        const at = state.items.findIndex((i) => i.id === item.id)
        return go(state, openItem(state, at + 1))
      }
      return stay(state)
    }
    case 'alts': {
      const item = findItem(state, s.id)
      if (!item) return go(state, { kind: 'home' })
      if (input.type !== 'press') return stay(state)
      const list = altItems(item)
      const label = list[input.index ?? 0]
      if (label === undefined) return stay(state)
      if (label === BACK) return go(state, { kind: 'mail', id: item.id, draft: s.draft })
      return go(state, { kind: 'mail', id: item.id, draft: label })
    }
    case 'confirm': {
      const item = findItem(state, s.id)
      if (!item) return go(state, { kind: 'home' })
      if (input.type !== 'press') return stay(state)
      const label = CONFIRM_ITEMS[input.index ?? 0]
      if (label === BACK) return go(state, { kind: 'mail', id: item.id, draft: s.draft })
      if (label === SEND_NOW) {
        const at = state.items.findIndex((i) => i.id === item.id)
        const items = state.items.filter((i) => i.id !== item.id)
        const next: AppState = { items, sent: [...state.sent, { id: item.id, draft: s.draft }], screen: state.screen }
        return go(next, { kind: 'sent', id: item.id, source: item.source, nextIndex: at }, 'fake-send')
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
      // Static preview of the F states: swipe walks through them, press goes home.
      const at = STATE_ORDER.indexOf(s.which)
      if (input.type === 'press') return go(state, { kind: 'home' })
      if (input.type === 'down') return go(state, { kind: 'state', which: STATE_ORDER[Math.min(at + 1, STATE_ORDER.length - 1)] })
      if (input.type === 'up') return go(state, { kind: 'state', which: STATE_ORDER[Math.max(at - 1, 0)] })
      return stay(state)
    }
  }
}
