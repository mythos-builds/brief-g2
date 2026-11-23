// The app's client for the Brief Worker (BRIEF-D2.md § 3, the contract). No SDK and no DOM here: `fetch` and the
// storage are passed in, so `npm test` runs it against a stubbed backend.
// Tokens: read only from the answers, sent only in the Authorization header, never logged, never put in an error.
// A demo session lives in memory only; a paired session is kept with the SDK's storage bridge (setLocalStorage).
import type { Item, Source } from '../logic/types.ts'
import { validAlts, validDraft } from '../logic/items.ts'

export type Mode = 'demo' | 'paired'
/** What the glasses say when a call fails (an F state), never a raw error. */
export type Failure = 'offline' | 'later' | 'limit' | 'signin' | 'error'
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

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number
  json(): Promise<unknown>
}>

export interface ClientOptions {
  base: string // '' = same origin
  fetch: FetchLike
  storage: KeyValue
}

export const PAIRED_KEY = 'brief.paired-session'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const CODE_RE = /^\d{6}$/

interface Session {
  token: string
  mode: Mode
}

/** HTTP status (+ the contract's error code) → what the glasses say. */
export function failureOf(status: number, code: unknown): Failure | Gone {
  if (status === 404 || status === 409) return 'gone'
  if (status === 429) return code === 'daily_cap' ? 'limit' : 'later'
  if (status === 401 || status === 403) return 'signin'
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

  async function call(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (auth && session) headers.authorization = `Bearer ${session.token}`
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await opts.fetch(`${opts.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
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

  /** Runs an authorised call; a 401 gets ONE new demo session and one retry (a stale paired session is forgotten). */
  async function authed(method: string, path: string, body?: unknown, requirePairing = false) {
    if (!session) await start(requirePairing)
    let r = await call(method, path, body)
    if (r.status === 401) {
      if (session?.mode === 'paired') await opts.storage.set(PAIRED_KEY, '').catch(() => false)
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
    if (r.status !== 200) throw new BackendError(failureOf(r.status, codeOf(r.json)))
    const o = (r.json ?? {}) as { sent?: unknown; real?: unknown }
    if (o.sent !== true) throw new BackendError('error')
    return { real: o.real === true }
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

  return { start, items, send, skip, claim, mode: (): Mode | undefined => session?.mode }
}

export type Client = ReturnType<typeof createClient>
