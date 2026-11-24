// BRIEF-D4 § 6.3 (day-3 open item 3): what a worst-case sync run uses — NEW_PER_RUN new messages, BRIEFS_PER_RUN
// briefs, the calendar — counted against Cloudflare's FREE-plan limits (read 2026-11-23, quotes in src/sync.ts): 50
// subrequests per invocation, 50 D1 queries per invocation (« a db.batch() call counts as a single query »). Each must
// stay 20 % under, and (D4 review, FIX 1) so must their SUM: a D1 query is a subrequest too.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { BRIEFS_PER_RUN, CF_FREE, NEW_PER_RUN, RUN_MAX_REQUESTS, RUN_WALL_S, MODEL_START_BEFORE_S } from '../src/sync'
import { clock } from './helpers'
import { alias, fakeModules, FakeUpstream, OPENROUTER, pairedSession, sync, syncEnv } from './sync-fakes'

const T0 = 1_795_000_000

/** D1 as Cloudflare counts it: each statement run alone = 1 query, each batch() = 1 query (and N statements). */
function countingDb(db: D1Database): { db: D1Database; n: { queries: number; statements: number } } {
  const n = { queries: 0, statements: 0 }
  const real = new WeakMap<object, D1PreparedStatement>()
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, k) {
        if (k === 'bind') return (...a: unknown[]) => wrap(t.bind(...a))
        if (k === 'first' || k === 'all' || k === 'run' || k === 'raw')
          return (...a: unknown[]) => {
            n.queries += 1
            n.statements += 1
            return (t[k] as (...x: unknown[]) => unknown).apply(t, a)
          }
        const v = Reflect.get(t, k, t) as unknown
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
      },
    })
    real.set(p, s)
    return p
  }
  const counted = new Proxy(db, {
    get(t, k) {
      if (k === 'prepare') return (sql: string) => wrap(t.prepare(sql))
      if (k === 'batch')
        return (stmts: D1PreparedStatement[]) => {
          n.queries += 1
          n.statements += stmts.length
          return t.batch(stmts.map((s) => real.get(s) ?? s))
        }
      const v = Reflect.get(t, k, t) as unknown
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
    },
  })
  return { db: counted, n }
}

beforeEach(() => {
  clock.t = T0
})

describe('a worst-case sync run stays 20 % under the FREE-plan limits (§ 6.3)', () => {
  it(`${NEW_PER_RUN} new messages, ${BRIEFS_PER_RUN} briefs, the calendar: outgoing requests and D1 queries counted`, async () => {
    await pairedSession()
    const up = new FakeUpstream()
    // earlier runs (not counted) stored 3 mails each of lina and priya
    up.mails = ['lina', 'priya', 'lina', 'priya', 'lina', 'priya'].map((k, i) => ({ id: `old${i}`, from: alias(k), at: T0 - 5000 - 100 * i }))
    while ((await sync(up, fakeModules())).triaged > 0);
    // the counted run: the access token has expired (one refresh), the label got a new id (one update), NEW_PER_RUN
    // new persona mails (a get and a model call each), and three events with a persona → BRIEFS_PER_RUN briefs of
    // 3 mails each (3 gets and a model call each)
    clock.t = T0 + 3700
    up.labels = [{ id: 'INBOX', name: 'INBOX' }, { id: 'Label_43', name: 'brief-demo' }]
    up.listLabel = 'Label_43'
    up.mails.push(...['marco', 'jordan', 'marco', 'jordan', 'marco', 'jordan'].map((k, i) => ({ id: `new${i}`, from: alias(k), at: T0 + 3000 + i })))
    up.events = [
      { id: 'e1', summary: 'Supplier call', start: T0 + 4300, attendees: [alias('lina')] },
      { id: 'e2', summary: 'Line 2 visit', start: T0 + 9000, attendees: [alias('priya')] },
      { id: 'e3', summary: 'Shift review', start: T0 + 9900, attendees: [alias('marco')] },
    ]
    up.calls = []
    const { db, n } = countingDb((env as Env).DB)
    const r = await sync(up, fakeModules(), syncEnv({ DB: db }))
    expect(r.triaged).toBe(NEW_PER_RUN)
    expect(r.briefs).toBe(BRIEFS_PER_RUN)
    expect(r.capped).toBe(false)
    const outgoing = up.calls.length
    expect(r.requests).toBe(outgoing)
    // the numbers this file measures (README « Cloudflare limits »)
    expect({ outgoing, models: up.modelCalls, d1Queries: n.queries, d1Statements: n.statements }).toEqual(WORST)
    // 20 % under every limit
    expect(outgoing).toBeLessThanOrEqual(0.8 * CF_FREE.subrequests)
    expect(RUN_MAX_REQUESTS).toBeLessThanOrEqual(0.8 * CF_FREE.subrequests)
    expect(n.queries).toBeLessThanOrEqual(0.8 * CF_FREE.d1Queries)
    // D4 review, FIX 1: « A subrequest is any request a Worker makes using the Fetch API or to Cloudflare services like
    // R2, KV, or D1 » and D1's « Queries per Worker invocation (read subrequest limits) »: the two share ONE budget of
    // 50. The safe reading is the sum, held 20 % under it.
    expect(outgoing + n.queries).toBeLessThanOrEqual(0.8 * CF_FREE.subrequests)
    expect(RUN_WALL_S).toBeLessThanOrEqual(0.8 * CF_FREE.waitUntilS)
    expect(MODEL_START_BEFORE_S).toBeLessThan(RUN_WALL_S)
    expect(up.calls.some((c) => c.url === OPENROUTER)).toBe(true)
  })
})

const WORST = { outgoing: 12, models: 3, d1Queries: 23, d1Statements: 26 }
