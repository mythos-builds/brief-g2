// /api/* (contract BRIEF-D2 § 3, points 1 to 5; BRIEF-D3 § 3.1 to 3.4; BRIEF-D4 § 3.2 to 3.8). Demo mode never
// sends. A real mail leaves ONLY from postSend in paired mode, when REAL_SEND is exactly "on" (send.ts).
import { newToken, sha256hex, TOKEN_RE } from './crypto.ts'
import type { Deps, Env } from './env.ts'
import { error, json, readBodyCapped, readJsonObject } from './http.ts'
import { DEMO_ITEMS, findItem, ID_RE, type Item } from './items.ts'
import { addressKey, dayKey, endOfDay, hit, HOUR, purge } from './limits.ts'
import { accountGate, markPairedHandled, pairedCalendar, pairedItem, pairedItems } from './paired.ts'
import { DEMO_CALENDAR } from './personas.ts'
import { claimSend, finishSend, realSendOn, releaseSend, sendReply } from './send.ts'

export const DEMO_TTL = 7200
export const PAIRED_TTL = 604_800
export const CODE_TTL = 600
export const BODY_MAX = 200

export interface Session {
  hash: string
  mode: 'demo' | 'paired'
  expiresAt: number
  accountId: number | null
}

/** Creates a session row and returns the token (shown once, never stored: only its SHA-256). */
export async function createSession(
  db: D1Database,
  now: number,
  mode: 'demo' | 'paired',
  accountId: number | null,
): Promise<{ token: string; ttl: number }> {
  const ttl = mode === 'demo' ? DEMO_TTL : PAIRED_TTL
  const token = newToken()
  await db
    .prepare('INSERT INTO sessions (token_hash, mode, account_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(await sha256hex(token), mode, accountId, now + ttl, now)
    .run()
  return { token, ttl }
}

/** The session named by `Authorization: Bearer <token>` ONLY (never a query string, never a cookie). */
export async function authSession(request: Request, db: D1Database, now: number): Promise<Session | null> {
  const m = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '')
  if (!m || !TOKEN_RE.test(m[1]!)) return null
  const hash = await sha256hex(m[1]!)
  const row = await db
    .prepare('SELECT mode, expires_at, account_id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2')
    .bind(hash, now)
    .first<{ mode: 'demo' | 'paired'; expires_at: number; account_id: number | null }>()
  return row ? { hash, mode: row.mode, expiresAt: row.expires_at, accountId: row.account_id } : null
}

function onlyKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const k = Object.keys(o)
  return k.length === keys.length && keys.every((x) => k.includes(x))
}

// 1. POST /api/session {"mode":"demo"}
export async function postSession(request: Request, env: Env, deps: Deps, ctx: ExecutionContext): Promise<Response> {
  const body = await readJsonObject(request, BODY_MAX)
  if (!body || !onlyKeys(body, ['mode']) || body.mode !== 'demo') return error('bad_request')
  const now = deps.now()
  const addr = await addressKey(request)
  const refused = await hit(env.DB, now, [
    { key: `session:addr:${addr}`, max: 20, windowEnd: now + HOUR, code: 'rate_limited' },
    { key: `session:day:${dayKey(now)}`, max: 2000, windowEnd: endOfDay(now), code: 'daily_cap' },
  ])
  if (refused) return error(refused.code, refused.retryAfter)
  const { token, ttl } = await createSession(env.DB, now, 'demo', null)
  ctx.waitUntil(purge(env.DB, now).catch(() => {}))
  return json({ session: token, mode: 'demo', expires_in: ttl })
}

// 2. POST /api/pair/claim {"code":"123456"}
export async function postPairClaim(request: Request, env: Env, deps: Deps): Promise<Response> {
  const now = deps.now()
  const addr = await addressKey(request)
  // every try counts, valid or not: 5 per address per 10 minutes
  const refused = await hit(env.DB, now, [
    { key: `claim:addr:${addr}`, max: 5, windowEnd: now + 600, code: 'rate_limited' },
  ])
  if (refused) return error(refused.code, refused.retryAfter)
  // 20 failed claims from all addresses together → every claim refused for 10 minutes
  const lock = await env.DB.prepare("SELECT window_end FROM counters WHERE key = 'pair:lock' AND window_end > ?1")
    .bind(now)
    .first<{ window_end: number }>()
  if (lock) return error('rate_limited', lock.window_end - now)

  const body = await readJsonObject(request, BODY_MAX)
  if (!body || !onlyKeys(body, ['code']) || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code))
    return error('bad_request')
  // D2 review, finding 3: the lock above is read before the code is tried, so a burst could pass it all at once.
  // Each try first takes one of 20 global slots per 10 minutes in ONE atomic upsert; a good code gives its slot back,
  // so the slots count failed claims and claims in flight: never more than 20 codes tried per window.
  const slot = await hit(env.DB, now, [{ key: 'claim:global', max: 20, windowEnd: now + 600, code: 'rate_limited' }])
  if (slot) return error(slot.code, slot.retryAfter)

  const claimed = await env.DB.prepare(
    'UPDATE pair_codes SET used_at = ?2 WHERE code_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING account_id',
  )
    .bind(await sha256hex(`code:${body.code}`), now)
    .first<{ account_id: number }>()
  if (!claimed) {
    // wrong, used and expired codes get the same answer; the failure counts toward the global lock
    const [, counted] = await env.DB.batch<{ n: number }>([
      env.DB.prepare('INSERT INTO pair_failures (at) VALUES (?1)').bind(now),
      env.DB.prepare('SELECT COUNT(*) AS n FROM pair_failures WHERE at > ?1').bind(now - 600),
    ])
    if ((counted?.results?.[0]?.n ?? 0) >= 20) {
      await env.DB.prepare(
        `INSERT INTO counters (key, count, window_end) VALUES ('pair:lock', 1, ?1)
         ON CONFLICT (key) DO UPDATE SET count = 1, window_end = ?1 WHERE counters.window_end <= ?2`,
      )
        .bind(now + 600, now)
        .run()
    }
    return error('not_found')
  }
  await env.DB.prepare("UPDATE counters SET count = count - 1 WHERE key = 'claim:global' AND count > 0").run()
  const { token, ttl } = await createSession(env.DB, now, 'paired', claimed.account_id)
  return json({ session: token, mode: 'paired', expires_in: ttl })
}

// 3. GET /api/items. Paired (BRIEF-D3 § 3.2): this ACCOUNT's stored items; a dead grant → 403 signin_needed.
export async function getItems(request: Request, env: Env, deps: Deps): Promise<Response> {
  const now = deps.now()
  const s = await authSession(request, env.DB, now)
  if (!s) return error('unauthorized')
  if (s.mode === 'paired') {
    const gate = await accountGate(env, s.accountId, false)
    if ('error' in gate) return error(gate.error)
    return json({ mode: 'paired', items: await pairedItems(env, gate.account.id) })
  }
  if (!DEMO_ITEMS) return error('server_error')
  const done = await env.DB.prepare('SELECT item_id FROM handled WHERE token_hash = ?1').bind(s.hash).all<{ item_id: string }>()
  const handled = new Set(done.results.map((r) => r.item_id))
  return json({ mode: s.mode, items: DEMO_ITEMS.filter((i) => !handled.has(i.id)) })
}

/** Marks an item handled for this session in ONE conditional insert: the second of two racing requests gets 409. */
async function markHandled(db: D1Database, s: Session, id: string, action: 'send' | 'skip', choice: number | null) {
  const row = await db
    .prepare(
      `INSERT INTO handled (token_hash, item_id, action, choice, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (token_hash, item_id) DO NOTHING RETURNING item_id`,
    )
    .bind(s.hash, id, action, choice, s.expiresAt)
    .first()
  return row !== null
}

/** One log line per real send: step names, counts and codes only; never an address, a subject, a body, a token. */
function sendLog(fields: Record<string, string | number>): void {
  console.log(JSON.stringify({ route: 'api.items.send', ...fields }))
}

// 4. POST /api/items/<id>/send {"choice":n}. Paired: the checks of BRIEF-D4 § 3.2 in their order, a to j.
export async function postSend(request: Request, env: Env, deps: Deps, id: string): Promise<Response> {
  const now = deps.now()
  // a. a valid session
  const s = await authSession(request, env.DB, now)
  if (!s) return error('unauthorized')
  let item: Item | undefined
  let accountId: number | null = null
  let account: Awaited<ReturnType<typeof accountGate>> | null = null
  if (s.mode === 'paired') {
    // b. today's allow-list (401) · a live grant (403) · REAL_SEND on → the gmail.send scope (403)
    account = await accountGate(env, s.accountId, true)
    if ('error' in account) return error(account.error)
    accountId = account.account.id
    // c. the account's stored item, handled or not (BRIEF-D3 § 3.3)
    item = ID_RE.test(id) ? (await pairedItem(env, accountId, id))?.item : undefined
  } else {
    if (!DEMO_ITEMS) return error('server_error')
    item = ID_RE.test(id) ? findItem(DEMO_ITEMS, id) : undefined
  }
  if (!item) return error('not_found')
  // d. the route limits of day 2
  const addr = await addressKey(request)
  const refused = await hit(env.DB, now, [
    { key: `send:session:${s.hash}`, max: 30, windowEnd: s.expiresAt, code: 'rate_limited' },
    { key: `send:addr:${addr}`, max: 60, windowEnd: now + HOUR, code: 'rate_limited' },
    { key: `send:day:${dayKey(now)}`, max: 3000, windowEnd: endOfDay(now), code: 'daily_cap' },
  ])
  if (refused) return error(refused.code, refused.retryAfter)
  // e. the body is {"choice":n} and nothing else: never a text, never an address
  const body = await readJsonObject(request, BODY_MAX)
  if (!body || !onlyKeys(body, ['choice'])) return error('bad_request')
  const c = body.choice
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c > 4) return error('bad_request')
  const text = c === 0 ? item.draft : item.alts[c - 1]
  if (typeof text !== 'string' || text.trim() === '') return error('bad_request')
  if (accountId === null || !account || 'error' in account) {
    // demo: unchanged, nothing leaves
    if (!(await markHandled(env.DB, s, item.id, 'send', c))) return error('already_handled')
    return json({ sent: true, real: false })
  }
  // f. REAL_SEND not exactly "on" → day-3 behaviour: marked handled, no Google call at all
  if (!realSendOn(env)) {
    if (!(await markPairedHandled(env.DB, accountId, item.id, 'send', c, now))) return error('already_handled')
    return json({ sent: true, real: false })
  }
  // g + h. the daily cap of real sends and the claim (ONE conditional update, in one transaction with the count)
  const claim = await claimSend(env.DB, env, accountId, item.id, c, now)
  if (claim.kind !== 'claimed') {
    sendLog({ step: 'claim', code: claim.kind })
    return error(claim.kind)
  }
  // i. the Google calls · j. the outcome
  const { outcome, calls } = await sendReply(env, deps, account.account, { id: item.id, threadId: claim.threadId, persona: claim.persona }, text)
  sendLog({
    step: 'outcome',
    outcome: outcome.kind,
    calls,
    ...('step' in outcome ? { at: outcome.step } : {}),
    ...('status' in outcome && outcome.status !== undefined ? { status: outcome.status } : {}),
  })
  switch (outcome.kind) {
    case 'sent':
      await finishSend(env.DB, accountId, item.id, 'sent', outcome.sentId)
      return json({ sent: true, real: true })
    case 'unknown':
      // it may have left: the row stays handled, never retried, never offered again
      await finishSend(env.DB, accountId, item.id, 'unknown', null)
      return error('send_unknown')
    case 'signin':
      await releaseSend(env.DB, accountId, item.id)
      return error('signin_needed')
    default:
      // definite: nothing left; the item is offered again
      await releaseSend(env.DB, accountId, item.id)
      return error('send_failed')
  }
}

// 5. POST /api/items/<id>/skip, empty body. Paired: checks a and b of BRIEF-D4 § 3.2 first (§ 3.7), then as day 3.
export async function postSkip(request: Request, env: Env, deps: Deps, id: string): Promise<Response> {
  const now = deps.now()
  const s = await authSession(request, env.DB, now)
  if (!s) return error('unauthorized')
  let item: Item | undefined
  if (s.mode === 'paired') {
    const gate = await accountGate(env, s.accountId, true)
    if ('error' in gate) return error(gate.error)
    item = ID_RE.test(id) ? (await pairedItem(env, gate.account.id, id))?.item : undefined
  } else {
    if (!DEMO_ITEMS) return error('server_error')
    item = ID_RE.test(id) ? findItem(DEMO_ITEMS, id) : undefined
  }
  if (!item) return error('not_found')
  const raw = await readBodyCapped(request, BODY_MAX)
  if (!raw || raw.byteLength !== 0) return error('bad_request')
  const marked =
    s.mode === 'paired'
      ? await markPairedHandled(env.DB, s.accountId!, item.id, 'skip', null, now)
      : await markHandled(env.DB, s, item.id, 'skip', null)
  if (!marked) return error('already_handled')
  return json({ skipped: true })
}

// 6. GET /api/calendar (BRIEF-D3 § 3.4). Demo: the frozen file. Paired: the account's stored rows; dead grant → 403.
export async function getCalendar(request: Request, env: Env, deps: Deps): Promise<Response> {
  const now = deps.now()
  const s = await authSession(request, env.DB, now)
  if (!s) return error('unauthorized')
  if (s.mode === 'paired') {
    const gate = await accountGate(env, s.accountId, false)
    if ('error' in gate) return error(gate.error)
    const cal = await pairedCalendar(env, gate.account.id, now)
    return json({ mode: 'paired', now: cal.now, events: cal.events })
  }
  if (!DEMO_CALENDAR) return error('server_error')
  const events = DEMO_CALENDAR.events.filter((e) => e.start > DEMO_CALENDAR!.now).slice(0, 5)
  return json({ mode: 'demo', now: DEMO_CALENDAR.now, events })
}

// 7. POST /api/session/logout, Bearer, empty body (BRIEF-D4 § 3.8): the session row is deleted (demo or paired).
// 30 per address per hour; no, unknown or expired session → 401, so a second call → 401.
export async function postLogout(request: Request, env: Env, deps: Deps): Promise<Response> {
  const now = deps.now()
  const addr = await addressKey(request)
  const refused = await hit(env.DB, now, [{ key: `logout:addr:${addr}`, max: 30, windowEnd: now + HOUR, code: 'rate_limited' }])
  if (refused) return error(refused.code, refused.retryAfter)
  const s = await authSession(request, env.DB, now)
  if (!s) return error('unauthorized')
  const raw = await readBodyCapped(request, BODY_MAX)
  if (!raw || raw.byteLength !== 0) return error('bad_request')
  // ONE conditional delete: of two logouts at the same moment, one gets 200, the other 401
  const gone = await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1 RETURNING 1 AS ok').bind(s.hash).first()
  if (!gone) return error('unauthorized')
  return json({ ok: true })
}
