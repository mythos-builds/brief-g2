// The screens as a state machine: (state, gesture) → (state, effect). Pure, so `npm test` proves the rules:
// - double-press is the system exit dialog everywhere, never bound to an action;
// - a send = `Send` on B, then `Send now` on C (the cursor starts on `Back`): two deliberate presses on labelled items;
// - nothing is ever sent: `fake-send` only records the reply in memory.
import type { AppState, CalEvent, Dataset, Effect, Input, Item, MailScreen, Screen, StateName, VoiceMsg } from './types.ts'
import type { BackendError } from '../data/backend.ts'
import { briefDueIn, eventsOf } from './items.ts'

export const ACT_SEND = 'Send'
export const ACT_OTHER = 'Other answers'
export const ACT_SKIP = 'Skip'
/** BRIEF-D5.md § 3.10: offered only when the items answer said `"voice": true` (never in static mode). */
export const ACT_SPEAK = 'Speak a change'
export const BACK = 'Back'
export const SEND_NOW = 'Send now'
export const STATE_ORDER: StateName[] = ['signin', 'offline', 'working', 'error', 'later', 'limit', 'sendcap', 'handled', 'unknown']

/** The event-capture list of each screen (its container name): a press from any other list is dropped. */
export const LIST_OF = { home: 'inbox', mail: 'act', alts: 'alts', confirm: 'ok' } as const

/** B's `act` list, in this order: `Send` only with a draft that passed the checks; `Other answers` only with ≥ 2 valid
 * alternatives; `Speak a change` only when the server offers the voice and B shows a reply to change; `Skip`. */
export function actItems(item: Item, draft: string = item.draft, voice = false): string[] {
  const out = draft ? [ACT_SEND] : []
  if (item.alts.length >= 2) out.push(ACT_OTHER)
  if (voice && draft) out.push(ACT_SPEAK)
  out.push(ACT_SKIP)
  return out
}

/** B for a text, with its `rev` only when that text is the stored spoken draft (absent otherwise: day-4 shapes kept). */
export function mailScreen(id: string, draft: string, rev?: string): MailScreen {
  return rev ? { kind: 'mail', id, draft, rev } : { kind: 'mail', id, draft }
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
  // Double-press = the system exit dialog on every screen. The state never changes, except while listening: then the
  // microphone goes off (main.ts, on `exit-dialog`) and the clip is dropped, so B as it was before the pick comes back.
  if (input.type === 'double') {
    if (state.screen.kind === 'listen') return go(state, state.screen.back, 'exit-dialog')
    return { state, effect: 'exit-dialog' }
  }

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
      const label = picked(actItems(item, s.draft, state.voice === true), input, LIST_OF.mail)
      if (label === ACT_SEND && s.draft) return go(state, withRev({ kind: 'confirm', id: item.id, draft: s.draft }, s.rev))
      if (label === ACT_OTHER) return go(state, withRev({ kind: 'alts', id: item.id, draft: s.draft }, s.rev))
      // the microphone starts only here, on this pick (decision 1.9): main.ts draws D first, then turns it on
      if (label === ACT_SPEAK && state.voice === true && s.draft) return go(state, { kind: 'listen', id: item.id, back: s }, 'mic-on')
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
      if (label === BACK) return go(state, mailScreen(item.id, s.draft, s.rev))
      // a line of `Other answers` = that line's own index again, never the spoken draft
      return go(state, { kind: 'mail', id: item.id, draft: label })
    }
    case 'confirm': {
      const item = findItem(state, s.id)
      if (!item) return go(state, { kind: 'home' })
      if (input.type !== 'press') return stay(state)
      const label = picked(CONFIRM_ITEMS, input, LIST_OF.confirm)
      if (label === BACK) return go(state, mailScreen(item.id, s.draft, s.rev))
      // the only path to a send: `Send now`, on C's own list, with its label (input.ts ties both to the page drawn now)
      if (label === SEND_NOW && input.list === LIST_OF.confirm && input.label === SEND_NOW) {
        const at = state.items.findIndex((i) => i.id === item.id)
        const items = state.items.filter((i) => i.id !== item.id)
        // `...state` first: everything else of the state stays (the `voice` flag: without it « Speak a change » was gone
        // from the next mail after a send, seen in the simulator at the day-5 gate)
        const next: AppState = { ...state, items, sent: [...state.sent, { id: item.id, draft: s.draft }] }
        return go(next, { kind: 'sent', id: item.id, source: item.source, nextIndex: at, real: false }, 'fake-send')
      }
      return stay(state)
    }
    case 'listen': {
      // D, the microphone on: a press stops it (main.ts: microphone off FIRST, then `Rewriting…` and the post)
      if (input.type !== 'press') return stay(state)
      return go(state, { kind: 'rewriting', id: s.id, back: s.back }, 'mic-stop')
    }
    case 'rewriting':
      // waiting for the server: every input is ignored (the double-press, above, is the exit)
      return stay(state)
    case 'voice': {
      if (input.type !== 'press') return stay(state)
      return go(state, findItem(state, s.back.id) ? s.back : { kind: 'home' })
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
  if (kind === 'failed') return { ...before, screen: { ...s, failed: true } } // the same text, the same choice (and rev)
  if (kind === 'stale') return { ...before, screen: staleScreen(before, s.id) }
  if (kind === 'unknown') {
    const at = before.items.findIndex((i) => i.id === s.id)
    return { ...before, items: before.items.filter((i) => i.id !== s.id), screen: { kind: 'state', which: 'unknown', nextIndex: Math.max(at, 0) } }
  }
  return { ...before, screen: { kind: 'state', which: stateOf(kind) } }
}

const STATE_KINDS: readonly string[] = STATE_ORDER
/** A client failure kind as an F state: the kinds that are no F state of their own (a speak's, `gone`, `failed`) → error. */
export function stateOf(kind: BackendError['kind']): StateName {
  return STATE_KINDS.includes(kind) ? (kind as StateName) : 'error'
}

/** Backend mode, `Skip` refused: 409 `already_handled` → `Already handled.` (then the list is read again); 404 → the
 * item leaves the list as a skip would; anything else → its F state. */
export function afterSkipFailure(skipped: AppState, id: string, kind: BackendError['kind']): AppState {
  if (kind === 'gone') return { ...skipped, items: skipped.items.filter((i) => i.id !== id) }
  const which: StateName = kind === 'unknown' ? 'error' : stateOf(kind)
  return { ...skipped, screen: { kind: 'state', which } }
}

function withRev<T extends { kind: 'confirm' | 'alts' }>(screen: T, rev: string | undefined): T {
  return rev ? { ...screen, rev } : screen
}

/** `stale_draft` (speak or send): the spoken draft is forgotten, so a press goes back to B with the item's own draft. */
function staleScreen(state: AppState, id: string): Screen {
  const item = findItem(state, id)
  return { kind: 'voice', which: 'stale', back: mailScreen(id, item?.draft ?? '') }
}

// ---- « Speak a change » (BRIEF-D5.md § 3.10): what happens when the microphone stops, and when the server answers ----

/** 0.4 s of 16 kHz signed 16-bit mono: a shorter clip is not posted at all (`Didn't hear you.`). */
export const MIN_CLIP_BYTES = 12_800
/** 10 s: the recorder stops by itself here. */
export const MAX_CLIP_BYTES = 320_000

/** Why the microphone went off (src/logic/recorder.ts). */
export type MicStop = 'press' | 'full' | 'time' | 'nomic' | 'exit' | 'background'

/**
 * The microphone is off (already: the recorder turns it off before it calls back). `post` = the clip goes to the server.
 * - press / full (320,000 bytes) / time (12 s): `Rewriting…` and post, unless the clip is under 12,800 bytes;
 * - nomic (no audio within 5 s): `No microphone. Use Other answers.`;
 * - exit (double-press) / background (the app left the foreground, or an abnormal exit): B as before, nothing posted.
 */
export function afterMic(state: AppState, reason: MicStop, bytes: number): { state: AppState; post: boolean } {
  const s = state.screen
  if (s.kind !== 'listen' && s.kind !== 'rewriting') return { state, post: false }
  const to = (screen: Screen) => ({ ...state, screen })
  if (reason === 'exit' || reason === 'background') return { state: to(s.back), post: false }
  if (reason === 'nomic') return { state: to({ kind: 'voice', which: 'nomic', back: s.back }), post: false }
  if (bytes < MIN_CLIP_BYTES) return { state: to({ kind: 'voice', which: 'notheard', back: s.back }), post: false }
  return { state: to({ kind: 'rewriting', id: s.id, back: s.back }), post: true }
}

/** The answer of `POST /api/items/<id>/speak`: the new draft and its rev, or the client's BackendError kind. */
export type SpeakOutcome = { ok: true; draft: string; rev: string } | { ok: false; kind: BackendError['kind'] }

const VOICE_OF: Partial<Record<BackendError['kind'], VoiceMsg>> = {
  notheard: 'notheard',
  voicelimit: 'limit',
  stale: 'stale',
}

/**
 * From `Rewriting…`: 200 → B with `Draft: <the new reply>` and its rev (then `Send` → C → `Send now` posts choice 5) ·
 * not_heard → `Didn't hear you.` · rate_limited / daily_cap → `Voice limit reached.` · stale_draft → `That draft is gone.`
 * (the spoken draft is forgotten) · already_handled → `Already handled.` (then the list is read again) · signin → F ·
 * 404 → undefined (the list is read again) · voice_failed, any other 5xx, no connection, 30 s → `Couldn't change the reply.`
 */
export function afterSpeak(state: AppState, r: SpeakOutcome): AppState | undefined {
  const s = state.screen
  if (s.kind !== 'rewriting') return state
  if (!findItem(state, s.id)) return undefined
  if (r.ok) return { ...state, screen: mailScreen(s.id, r.draft, r.rev) }
  if (r.kind === 'gone') return undefined
  if (r.kind === 'handled' || r.kind === 'signin') return { ...state, screen: { kind: 'state', which: r.kind } }
  if (r.kind === 'stale') return { ...state, screen: staleScreen(state, s.id) }
  const which = VOICE_OF[r.kind] ?? 'failed'
  return { ...state, screen: { kind: 'voice', which, back: s.back } }
}
