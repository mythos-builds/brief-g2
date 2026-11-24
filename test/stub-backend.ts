// An in-memory backend built from BRIEF-D2.md § 3, BRIEF-D3.md § 3 and BRIEF-D4.md § 3 (the contract), for the client
// tests and the backend shots. Day 4: the send outcomes (`REAL_SEND`, 502 `send_failed`, 504 `send_unknown`, 429
// `daily_cap` of real sends, 409 `already_handled`), and `POST /api/session/logout`.
// Not the Worker (job C): only what the app sees: status codes, {"error":"<code>"} bodies, sessions by
// bearer token, items minus handled (demo: per session; paired: per ACCOUNT), `GET /api/calendar`, and 403
// `signin_needed` for a paired account whose Google grant is dead.
import { randomBytes } from 'node:crypto'
import type { FetchLike } from '../src/data/backend.ts'
import type { CalEvent, Item } from '../src/logic/types.ts'

export interface Call {
  method: string
  path: string
  auth?: string
  body?: string
}

export interface StubCalendar {
  now: string
  events: CalEvent[]
}

export interface StubOptions {
  codes?: string[] // pairing codes; each gives a paired session of `account` (or of `codeAccounts[code]`)
  codeAccounts?: Record<string, string>
  dailyCap?: boolean
  pairedItems?: Item[] // the account's stored items (default: the same items as demo)
  demoCalendar?: StubCalendar // § 3.4: frozen in the Worker's bundled file
  pairedCalendar?: StubCalendar
}

export const STUB_ACCOUNT = 'acct-1' // an opaque account key: the stub never holds an address

export function stubBackend(items: Item[], opts: StubOptions = {}) {
  const sessions = new Map<string, { mode: 'demo' | 'paired'; account?: string; handled: Set<string> }>()
  const handledByAccount = new Map<string, Set<string>>()
  const codes = new Set(opts.codes ?? [])
  const calls: Call[] = []
  const state = {
    down: false,
    dailyCap: opts.dailyCap ?? false,
    serverError: false,
    calendarError: false,
    deadGrant: new Set<string>(), // accounts whose Google grant is dead → 403 signin_needed
    sent: [] as { id: string; choice: number }[],
    /** BRIEF-D4.md § 3.2 f: `REAL_SEND` exactly "on" → a real send (`"real":true`); anything else → `"real":false`. */
    realSend: 'off' as string,
    /** The outcome of the next real send (§ 3.4): ok = 200, failed = 502 (claim released), unknown = 504 (stays handled). */
    sendOutcome: 'ok' as 'ok' | 'failed' | 'unknown',
    sendDailyCap: 20, // § 3.2 g, per account; counted when claimed, never given back
    realSends: new Map<string, number>(),
  }
  const demoCalendar: StubCalendar = opts.demoCalendar ?? { now: '12:41', events: [] }
  const pairedCalendar: StubCalendar = opts.pairedCalendar ?? { now: '09:00', events: [] }
  const handledOf = (s: { mode: 'demo' | 'paired'; account?: string; handled: Set<string> }) => {
    if (s.mode === 'demo' || !s.account) return s.handled
    let h = handledByAccount.get(s.account)
    if (!h) handledByAccount.set(s.account, (h = new Set()))
    return h
  }

  const token = () => randomBytes(32).toString('base64url')
  const answer = (status: number, body: unknown) => ({ status, json: async () => body })
  const err = (status: number, code: string) => answer(status, { error: code })

  const fetch: FetchLike = async (url, init) => {
    if (state.down) throw new TypeError('Failed to fetch')
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const auth = init.headers.authorization
    calls.push({ method: init.method, path, auth, body: init.body })
    if (state.serverError) return err(500, 'server_error')
    const bearer = /^Bearer (\S+)$/.exec(auth ?? '')?.[1]
    const sess = bearer ? sessions.get(bearer) : undefined
    const body = init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>)

    if (init.method === 'POST' && path === '/api/session') {
      if (state.dailyCap) return err(429, 'daily_cap')
      if (JSON.stringify(body) !== '{"mode":"demo"}') return err(400, 'bad_request')
      const t = token()
      sessions.set(t, { mode: 'demo', handled: new Set() })
      return answer(200, { session: t, mode: 'demo', expires_in: 7200 })
    }
    if (init.method === 'POST' && path === '/api/pair/claim') {
      const code = body?.code
      if (typeof code !== 'string' || !codes.has(code)) return err(404, 'not_found')
      codes.delete(code)
      const t = token()
      sessions.set(t, { mode: 'paired', account: opts.codeAccounts?.[code] ?? STUB_ACCOUNT, handled: new Set() })
      return answer(200, { session: t, mode: 'paired', expires_in: 604800 })
    }
    if (!sess) return err(401, 'unauthorized')
    if (init.method === 'POST' && path === '/api/session/logout') {
      // § 3.8: Bearer, empty body → 200 {"ok":true}, the session is gone; a second call → 401 (above)
      if (init.body !== undefined && init.body !== '') return err(400, 'bad_request')
      sessions.delete(bearer as string)
      return answer(200, { ok: true })
    }
    const handled = handledOf(sess)
    const pool = sess.mode === 'paired' ? (opts.pairedItems ?? items) : items
    if (sess.mode === 'paired' && sess.account && state.deadGrant.has(sess.account)) return err(403, 'signin_needed')
    if (init.method === 'GET' && path === '/api/items')
      return answer(200, { mode: sess.mode, items: pool.filter((i) => !handled.has(i.id)).slice(0, 20) })
    if (init.method === 'GET' && path === '/api/calendar') {
      if (state.calendarError) return err(500, 'server_error')
      const cal = sess.mode === 'paired' ? pairedCalendar : demoCalendar
      return answer(200, { mode: sess.mode, now: cal.now, events: cal.events.slice(0, 5) })
    }
    const m = /^\/api\/items\/([^/]+)\/(send|skip)$/.exec(path)
    if (init.method === 'POST' && m) {
      const id = decodeURIComponent(m[1])
      const item = pool.find((i) => i.id === id)
      if (!item) return err(404, 'not_found')
      if (handled.has(id)) return err(409, 'already_handled')
      if (m[2] === 'send') {
        if ((init.body ?? '').length > 200) return err(400, 'bad_request')
        const keys = Object.keys(body ?? {})
        const choice = body?.choice
        if (keys.length !== 1 || keys[0] !== 'choice' || typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice > 4)
          return err(400, 'bad_request')
        if (choice > 0 && item.alts[choice - 1] === undefined) return err(400, 'bad_request')
        if (sess.mode !== 'paired' || state.realSend !== 'on') {
          handled.add(id)
          state.sent.push({ id, choice })
          return answer(200, { sent: true, real: false })
        }
        const acct = sess.account ?? ''
        const used = state.realSends.get(acct) ?? 0
        if (used >= state.sendDailyCap) return err(429, 'daily_cap')
        state.realSends.set(acct, used + 1) // g: counted when claimed, never given back
        handled.add(id) // h: the claim
        state.sent.push({ id, choice })
        if (state.sendOutcome === 'failed') {
          handled.delete(id) // definite failure: the claim is released, the item is offered again
          state.sent.pop()
          return err(502, 'send_failed')
        }
        if (state.sendOutcome === 'unknown') return err(504, 'send_unknown') // stays handled, never offered again
        return answer(200, { sent: true, real: true })
      }
      if (init.body !== undefined && init.body !== '') return err(400, 'bad_request')
      handled.add(id)
      return answer(200, { skipped: true })
    }
    return err(404, 'not_found')
  }

  return {
    fetch,
    calls,
    state,
    expireAll: () => sessions.clear(),
    sessionCount: () => sessions.size,
  }
}

export function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: async (k: string) => data.get(k) ?? '',
    set: async (k: string, v: string) => (data.set(k, v), true),
  }
}
