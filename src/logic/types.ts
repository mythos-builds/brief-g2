// Shapes of the demo dataset (src/data/dataset.json, a copy of ../demo/dataset.json) and of the app's own state.

export type Source = 'mail' | 'telegram'

export interface Persona {
  name: string
  email?: string
  role?: string
  telegram?: string
  chat?: string
}

export interface MailRecord {
  from: string
  at: string
  needs_answer: boolean
  hidden?: string
  subject: string
  body?: string
  summary6?: string
  draft?: string
}

export interface TelegramRecord {
  from: string
  chat: string
  at: string
  mentions_user?: boolean
  muted?: boolean
  needs_answer: boolean
  text: string
  summary?: string
  draft?: string
}

export interface CalendarRecord {
  start: string
  title: string
  with: string
  brief?: { why: string; last: string; facts: string[] }
}

/** One calendar event as the glasses use it: BRIEF-D3.md § 3.4 `Event` (the Worker's answer, or the dataset's calendar). */
export interface CalEvent {
  start: string // "HH:MM"
  title: string // ≤ 60 characters
  who: string // "<fullName>, <company>" or ""
  brief?: { why: string; last: string; facts: string[] }
}

export interface Dataset {
  now: string
  personas: Record<string, Persona>
  mail: MailRecord[]
  calendar: CalendarRecord[]
  telegram: TelegramRecord[]
  expected_home_screen?: string
}

/** One « item that needs you », whatever its source. */
export interface Item {
  id: string
  source: Source
  persona: string
  name: string // short name shown on the glasses (first name)
  fullName: string
  address: string // mail address, or the Telegram chat
  chat?: string
  at: string
  summary: string
  draft: string
  alts: string[] // already validated (see validAlts)
}

/** BRIEF-D4.md § 3.11 adds three, after a send or a skip: `sendcap` (429 `daily_cap` on a send), `handled` (409
 * `already_handled`: then the list is read again) and `unknown` (504 `send_unknown`: a press goes on to the next item). */
export type StateName = 'signin' | 'offline' | 'working' | 'error' | 'later' | 'limit' | 'sendcap' | 'handled' | 'unknown'

/** BRIEF-D5.md § 3.10: the lines after a « Speak a change » that did not give a draft. A press → B as before the pick. */
export type VoiceMsg = 'notheard' | 'failed' | 'limit' | 'stale' | 'nomic'

/** B. `rev` is present only while B shows the stored spoken draft (BRIEF-D5.md § 3.5): its `Send now` posts choice 5. */
export type MailScreen = { kind: 'mail'; id: string; draft: string; rev?: string }

export type Screen =
  | { kind: 'home' }
  | MailScreen // B (B′ for Telegram)
  | { kind: 'alts'; id: string; draft: string; rev?: string } // D″, draft (and rev) = the one B shows, kept on Back
  | { kind: 'confirm'; id: string; draft: string; failed?: boolean; rev?: string } // C (C′); failed = the last send got 502 `send_failed`
  | { kind: 'listen'; id: string; back: MailScreen } // D: the microphone is on; back = B as it was before the pick
  | { kind: 'rewriting'; id: string; back: MailScreen } // D: the clip is posted, the microphone is off
  | { kind: 'voice'; which: VoiceMsg; back: MailScreen } // D: one of the five lines; a press → back
  | { kind: 'sent'; id: string; source: Source; nextIndex: number; real: boolean } // `Sent ✓`; real = the Worker said so
  | { kind: 'brief'; page: number } // E
  | { kind: 'state'; which: StateName; nextIndex?: number } // F; `unknown`: the item a press opens next

export interface AppState {
  items: Item[] // the items that still need you, in display order
  /** Backend mode: the items answer said `"voice": true` (BRIEF-D5.md § 3.7). Absent = false (static mode: never). */
  voice?: boolean
  sent: { id: string; draft: string }[] // faked sends, nothing leaves the app
  screen: Screen
}

/**
 * What the glasses get from a gesture. On a list press: `index` = the selected row, `list` = the container the event
 * names, `label` = the row's text. A press whose list or label does not match the screen now drawn is dropped
 * (review finding 2). input.ts fills `list` and `label` from the page drawn now; an SDK event that carries neither name
 * is taken only once that page has been up ≥ 300 ms (BRIEF-D3.md § 4.1b), so `Send now` also works on an index-only event.
 */
export type Input =
  | { type: 'press'; index?: number; list?: string; label?: string }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'double' }
  | { type: 'tick' } // the 2-second timer after `Sent ✓`

/**
 * `fake-send`: `Send now` was pressed; the reply is recorded in memory (static data: nothing leaves; backend mode:
 * main.ts posts the choice and shows `Sent` only after a 200) · `skip`: Skip on B (backend: the skip route) ·
 * `reload`: a press on an F state (backend: load the list again).
 */
export type Effect = 'none' | 'exit-dialog' | 'fake-send' | 'skip' | 'reload' | 'mic-on' | 'mic-stop'
// `mic-on`: B's `Speak a change` was picked; main.ts draws D FIRST, then starts the microphone (BRIEF-D5.md § 3.10) ·
// `mic-stop`: a press on D while listening; main.ts turns the microphone off BEFORE anything else, then posts the clip.

// ---- page description, pure data; src/main.ts turns it into SDK containers ----

export interface TextBox {
  kind: 'text'
  name: string
  x: number
  y: number
  w: number
  h: number
  pad: number
  capture: boolean
  content: string
}

export interface ListBox {
  kind: 'list'
  name: string
  x: number
  y: number
  w: number
  h: number
  pad: number
  capture: boolean
  items: string[]
}

export type Box = TextBox | ListBox

export interface PageSpec {
  screen: string // 'A' | 'B' | 'D2' | 'C' | 'SENT' | 'E' | 'F'
  boxes: Box[]
}
