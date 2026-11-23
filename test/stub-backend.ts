// An in-memory backend built from BRIEF-D2.md § 3 (the contract), for the client tests. Not the Worker (job C):
// only what the app sees: status codes, {"error":"<code>"} bodies, sessions by bearer token, items minus handled.
import { randomBytes } from 'node:crypto'
import type { FetchLike } from '../src/data/backend.ts'
import type { Item } from '../src/logic/types.ts'

export interface Call {
  method: string
  path: string
  auth?: string
  body?: string
}

export function stubBackend(items: Item[], opts: { codes?: string[]; dailyCap?: boolean } = {}) {
  const sessions = new Map<string, { mode: 'demo' | 'paired'; handled: Set<string> }>()
  const codes = new Set(opts.codes ?? [])
  const calls: Call[] = []
  const state = { down: false, dailyCap: opts.dailyCap ?? false, serverError: false, sent: [] as { id: string; choice: number }[] }

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
      sessions.set(t, { mode: 'paired', handled: new Set() })
      return answer(200, { session: t, mode: 'paired', expires_in: 604800 })
    }
    if (!sess) return err(401, 'unauthorized')
    if (init.method === 'GET' && path === '/api/items')
      return answer(200, { mode: sess.mode, items: items.filter((i) => !sess.handled.has(i.id)) })
    const m = /^\/api\/items\/([^/]+)\/(send|skip)$/.exec(path)
    if (init.method === 'POST' && m) {
      const id = decodeURIComponent(m[1])
      const item = items.find((i) => i.id === id)
      if (!item) return err(404, 'not_found')
      if (sess.handled.has(id)) return err(409, 'already_handled')
      if (m[2] === 'send') {
        if ((init.body ?? '').length > 200) return err(400, 'bad_request')
        const keys = Object.keys(body ?? {})
        const choice = body?.choice
        if (keys.length !== 1 || keys[0] !== 'choice' || typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice > 4)
          return err(400, 'bad_request')
        if (choice > 0 && item.alts[choice - 1] === undefined) return err(400, 'bad_request')
        sess.handled.add(id)
        state.sent.push({ id, choice })
        return answer(200, { sent: true, real: false })
      }
      if (init.body !== undefined && init.body !== '') return err(400, 'bad_request')
      sess.handled.add(id)
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
