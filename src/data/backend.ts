// The app's client for the Brief Worker (BRIEF-D2.md § 3, the contract). No SDK and no DOM here: `fetch` and the
// storage are passed in, so `npm test` runs it against a stubbed backend.
// Tokens: read only from the answers, sent only in the Authorization header, never logged, never put in an error.
// A demo session lives in memory only; a paired session is kept with the SDK's storage bridge (setLocalStorage).
import type { CalEvent, Item, Source } from '../logic/types.ts'
import { validAlts, validDraft } from '../logic/items.ts'

export type Mode = 'demo' | 'paired'
/** What the glasses say when a call fails (an F state), never a raw error. BRIEF-D4.md § 3.1 / 3.11 adds, for a send or
 * a skip: `handled` (409 `already_handled`) · `failed` (502 `send_failed`: nothing left, the item is offered again) ·
 * `unknown` (504 `send_unknown`, or any other 5xx on a send: it may have left, never offered again) · `sendcap`
 * (429 `daily_cap` on a send: the account's daily limit of real sends). */
export type Failure = 'offline' | 'later' | 'limit' | 'signin' | 'error' | 'handled' | 'failed' | 'unknown' | 'sendcap'
/** send / skip only: the item is unknown (404) or already handled (409) on the server → reload the list. */
export type Gone = 'gone'

export class BackendError extends Error {
  readonly kind: Failure | Gone
  constructor(kind: Failure | Gone) {
    super(kind) // the message is the kind only: no URL, no body, no token
    this.kind = kind
    this.name = 'BackendError'
  }
}

export interface KeyValue {
  get(key: string): Promise<string> // '' when absent (the SDK's getLocalStorage contract)
  set(key: string, value: string): Promise<boolean>
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number
  json(): Promise<unknown>
}>

export interface ClientOptions {
  base: string // '' = same origin
  fetch: FetchLike
  storage: KeyValue
  /** A paired session got a 401: it is forgotten (storage cleared) and the phone-side page must say so. */
  onPairedDropped?: () => void
  /** « Disconnect »: how long the logout call may take before the token is forgotten anyway (BRIEF-D4.md § 4.3). */
  logoutMs?: number
}

/** BRIEF-D4.md § 4.3: the logout call gets 3 s at most. */
export const LOGOUT_MS = 3000

/** The SDK bridge's own storage (`getLocalStorage` / `setLocalStorage`, index.d.ts) as the client's KeyValue. */
export function bridgeStorage(bridge: {
  getLocalStorage(key: string): Promise<string>
  setLocalStorage(key: string, value: string): Promise<boolean>
}): KeyValue {
  return {
    get: async (k) => (await bridge.getLocalStorage(k)) ?? '',
    set: (k, v) => bridge.setLocalStorage(k, v),
  }
}

export const PAIRED_KEY = 'brief.paired-session'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const CODE_RE = /^\d{6}$/

interface Session {
  token: string
  mode: Mode
}

/** HTTP status (+ the contract's error code) → what the glasses say. 403 `signin_needed` (BRIEF-D3.md § 3.1): the
 * paired account's Google grant is dead → « Sign-in needed »; the session itself is kept (a new sign-in revives it). */
export function failureOf(status: number, code: unknown, op: 'send' | 'other' = 'other'): Failure | Gone {
  if (status === 409) return code === 'already_handled' ? 'handled' : 'gone'
  if (status === 404) return 'gone'
  if (status === 429) return code === 'daily_cap' ? (op === 'send' ? 'sendcap' : 'limit') : 'later'
  if (status === 401 || status === 403) return 'signin'
  if (op === 'send' && status >= 500) {
    // only the Worker's own `send_failed` means « nothing left, for sure »; any other 5xx on a send may have left
    if (status === 502 && code === 'send_failed') return 'failed'
    return 'unknown'
  }
  return 'error'
}

/** The contract's Item, checked field by field: anything else is a server error, never shown. */
export function isItem(x: unknown): x is Item {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  const str = (k: string) => typeof o[k] === 'string'
  return (
    ['id', 'persona', 'name', 'fullName', 'address', 'at', 'summary', 'draft'].every(str) &&
    (o.source === 'mail' || o.source === 'telegram') &&
    (o.chat === undefined || typeof o.chat === 'string') &&
    Array.isArray(o.alts) &&
    o.alts.length === 4 &&
    o.alts.every((a) => typeof a === 'string')
  )
}

export interface CalendarAnswer {
  mode: Mode
  now: string
  events: CalEvent[]
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const line = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && !CONTROL.test(v)

/** BRIEF-D3.md § 3.4 `Event`, checked field by field (limits included); anything else is never drawn. */
export function isEvent(x: unknown): x is CalEvent {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.some((k) => !['start', 'title', 'who', 'brief'].includes(k))) return false
  if (typeof o.start !== 'string' || !HHMM.test(o.start) || !line(o.title, 60) || o.title === '' || !line(o.who, 120)) return false
  if (o.brief === undefined) return true
  const b = o.brief as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return false
  return (
    line(b.why, 60) &&
    line(b.last, 60) &&
    Array.isArray(b.facts) &&
    b.facts.length >= 1 &&
    b.facts.length <= 4 &&
    b.facts.every((f) => line(f, 60))
  )
}

export function isCalendar(x: unknown): x is CalendarAnswer {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (
    (o.mode === 'demo' || o.mode === 'paired') &&
    typeof o.now === 'string' &&
    HHMM.test(o.now) &&
    Array.isArray(o.events) &&
    o.events.length <= 5 &&
    o.events.every(isEvent)
  )
}

/**
 * Server items → the items the glasses may show: the app's SOURCES filter, in the server's order, and the same
 * checks as static data (src/logic/replies.ts) on the draft and each alternative. The server's own item is kept
 * as is in `raw` so a choice is always the index into ITS alts (0 = its draft, 1–4 = alts[n-1]).
 */
export function toShown(items: readonly Item[], sources: readonly Source[]): Item[] {
  return items
    .filter((i) => sources.includes(i.source))
    .map((i) => ({ ...i, alts: validAlts(i.alts), draft: validDraft(i.draft) }))
}

/** The choice for the text C showed: 0 = the server's draft, 1–4 = alts[n-1]; undefined = not one of them (never sent). */
export function choiceFor(raw: Item | undefined, shown: string): number | undefined {
  if (!raw || !shown) return undefined
  if (shown === raw.draft) return 0
  const i = raw.alts.indexOf(shown)
  return i >= 0 ? i + 1 : undefined
}

export function createClient(opts: ClientOptions) {
  let session: Session | undefined
  let raw = new Map<string, Item>()

  async function call(method: string, path: string, body?: unknown, auth = true, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (auth && session) headers.authorization = `Bearer ${session.token}`
    let res: Awaited<ReturnType<FetchLike>>
    try {
      const init: Parameters<FetchLike>[1] = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
      if (signal) init.signal = signal
      res = await opts.fetch(`${opts.base}${path}`, init)
    } catch {
      throw new BackendError('offline')
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      json = undefined
    }
    return { status: res.status, json }
  }

  const codeOf = (json: unknown) => (json && typeof json === 'object' ? (json as { error?: unknown }).error : undefined)

  function takeSession(json: unknown, mode: Mode): Session {
    const o = (json ?? {}) as { session?: unknown; mode?: unknown }
    if (typeof o.session !== 'string' || !TOKEN_RE.test(o.session) || o.mode !== mode) throw new BackendError('error')
    return { token: o.session, mode }
  }

  async function newDemoSession(): Promise<void> {
    session = undefined
    const r = await call('POST', '/api/session', { mode: 'demo' }, false)
    if (r.status !== 200) {
      const f = failureOf(r.status, codeOf(r.json))
      throw new BackendError(f === 'gone' ? 'error' : f)
    }
    session = takeSession(r.json, 'demo')
  }

  /** On start: the stored paired session if there is one, else (unless pairing is required) a new demo session. */
  async function start(requirePairing = false): Promise<Mode> {
    const stored = await opts.storage.get(PAIRED_KEY).catch(() => '')
    if (TOKEN_RE.test(stored)) session = { token: stored, mode: 'paired' }
    else if (requirePairing) throw new BackendError('signin')
    else await newDemoSession()
    return (session as Session).mode
  }

  /** Forget the paired session: memory and the SDK storage. */
  async function forgetPaired(): Promise<void> {
    session = undefined
    raw = new Map()
    await opts.storage.set(PAIRED_KEY, '').catch(() => false)
  }

  /**
   * Runs an authorised call. A 401 on a demo session gets ONE new demo session and one retry. A 401 on a paired
   * session is NEVER silently replaced by demo data (BRIEF-D3.md § 4.3): it is forgotten, the phone-side page is told,
   * and the glasses show « Sign-in needed »; a press there then starts a demo session (or pairing again).
   */
  async function authed(method: string, path: string, body?: unknown, requirePairing = false) {
    if (!session) await start(requirePairing)
    let r = await call(method, path, body)
    if (r.status === 401) {
      if (session?.mode === 'paired') {
        await forgetPaired()
        opts.onPairedDropped?.()
        throw new BackendError('signin')
      }
      if (requirePairing) throw new BackendError('signin')
      await newDemoSession()
      r = await call(method, path, body)
    }
    return r
  }

  async function items(sources: readonly Source[], requirePairing = false): Promise<Item[]> {
    const r = await authed('GET', '/api/items', undefined, requirePairing)
    if (r.status !== 200) {
      const f = failureOf(r.status, codeOf(r.json))
      throw new BackendError(f === 'gone' ? 'error' : f)
    }
    const o = (r.json ?? {}) as { items?: unknown; mode?: unknown }
    if (!Array.isArray(o.items) || !o.items.every(isItem)) throw new BackendError('error')
    raw = new Map(o.items.map((i) => [i.id, i]))
    return toShown(o.items, sources)
  }

  /** `Send now`: posts the choice for the text C showed. Resolves only on a 200 with {"sent":true}. */
  async function send(id: string, shown: string): Promise<{ real: boolean }> {
    const choice = choiceFor(raw.get(id), shown)
    if (choice === undefined) throw new BackendError('error')
    const r = await authed('POST', `/api/items/${encodeURIComponent(id)}/send`, { choice })
    if (r.status !== 200) throw new BackendError(failureOf(r.status, codeOf(r.json), 'send'))
    const o = (r.json ?? {}) as { sent?: unknown; real?: unknown }
    if (o.sent !== true) throw new BackendError('error')
    return { real: o.real === true }
  }

  /** `GET /api/calendar` (BRIEF-D3.md § 3.4). main.ts never lets a failure here block the list. */
  async function calendar(): Promise<CalendarAnswer> {
    const r = await authed('GET', '/api/calendar')
    if (r.status !== 200) {
      const f = failureOf(r.status, codeOf(r.json))
      throw new BackendError(f === 'gone' ? 'error' : f)
    }
    if (!isCalendar(r.json)) throw new BackendError('error')
    const { mode, now, events } = r.json
    return { mode, now, events: events.map((e) => ({ ...e })) }
  }

  /**
   * The phone-side « Disconnect » (BRIEF-D4.md § 4.3): first `POST /api/session/logout` with the paired token (3 s at
   * most, any failure ignored), then the token is forgotten here and in the SDK storage whatever the answer; back to demo.
   */
  async function disconnect(): Promise<void> {
    if (session?.mode === 'paired') {
      const abort = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<void>((ok) => (timer = setTimeout(ok, opts.logoutMs ?? LOGOUT_MS)))
      try {
        await Promise.race([call('POST', '/api/session/logout', undefined, true, abort.signal).catch(() => undefined), late])
      } finally {
        clearTimeout(timer)
        abort.abort()
      }
    }
    await forgetPaired()
  }

  async function skip(id: string): Promise<void> {
    const r = await authed('POST', `/api/items/${encodeURIComponent(id)}/skip`)
    if (r.status !== 200) throw new BackendError(failureOf(r.status, codeOf(r.json)))
  }

  /** The phone-side « Have a code? » form: 6 digits → a paired session, kept in the SDK storage. */
  async function claim(code: string): Promise<void> {
    if (!CODE_RE.test(code)) throw new BackendError('gone')
    const r = await call('POST', '/api/pair/claim', { code }, false)
    if (r.status !== 200) throw new BackendError(failureOf(r.status, codeOf(r.json)))
    const s = takeSession(r.json, 'paired')
    await opts.storage.set(PAIRED_KEY, s.token)
    session = s
  }

  return { start, items, calendar, send, skip, claim, disconnect, mode: (): Mode | undefined => session?.mode }
}

export type Client = ReturnType<typeof createClient>
