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

export type StateName = 'signin' | 'offline' | 'working' | 'error' | 'later' | 'limit'

export type Screen =
  | { kind: 'home' }
  | { kind: 'mail'; id: string; draft: string } // B (B′ for Telegram)
  | { kind: 'alts'; id: string; draft: string } // D″, draft = the one B shows, kept on Back
  | { kind: 'confirm'; id: string; draft: string } // C (C′)
  | { kind: 'sent'; id: string; source: Source; nextIndex: number } // `Sent ✓`, faked
  | { kind: 'brief'; page: number } // E
  | { kind: 'state'; which: StateName } // F

export interface AppState {
  items: Item[] // the items that still need you, in display order
  sent: { id: string; draft: string }[] // faked sends, nothing leaves the app
  screen: Screen
}

/**
 * What the glasses get from a gesture. On a list press: `index` = the selected row, `list` = the container the event
 * names, `label` = the row's text. A press whose list or label does not match the screen now drawn is dropped
 * (review finding 2), and `Send now` needs its label: a press with no label never sends.
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
export type Effect = 'none' | 'exit-dialog' | 'fake-send' | 'skip' | 'reload'

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
