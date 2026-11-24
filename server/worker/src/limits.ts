// Rate limits and caps on D1. Each counter is ONE atomic upsert … RETURNING: two requests at the same moment get
// two different counts, so they can never both take the last slot.
import { sha256hex } from './crypto.ts'

export const HOUR = 3600
export const DAY = 86_400

const UPSERT = `INSERT INTO counters (key, count, window_end) VALUES (?1, 1, ?2)
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN counters.window_end <= ?3 THEN 1 ELSE counters.count + 1 END,
  window_end = CASE WHEN counters.window_end <= ?3 THEN ?2 ELSE counters.window_end END
RETURNING count, window_end`

export interface Limit {
  key: string
  max: number
  /** Window end for a new window, Unix seconds. */
  windowEnd: number
  /** The error when this limit is passed. */
  code: 'rate_limited' | 'daily_cap'
}

export interface Refusal {
  code: 'rate_limited' | 'daily_cap'
  retryAfter: number
}

// A later limit counts only when every earlier (narrower) one of the same batch is still within its max, so a hit
// refused by its address or session never fills a global total (D2 review, finding 1). Same counting rules as UPSERT.
function guardedUpsert(prev: Limit[]): string {
  const over = prev.map((_, j) => `(key = ?${4 + 2 * j} AND count > ?${5 + 2 * j})`).join(' OR ')
  return `INSERT INTO counters (key, count, window_end)
SELECT ?1, 1, ?2 WHERE NOT EXISTS (SELECT 1 FROM counters WHERE ${over})
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN counters.window_end <= ?3 THEN 1 ELSE counters.count + 1 END,
  window_end = CASE WHEN counters.window_end <= ?3 THEN ?2 ELSE counters.window_end END
RETURNING count, window_end`
}

/**
 * Counts one hit on the limits, narrowest first, in ONE batch (a D1 batch runs as one transaction) and returns the
 * first one that is over its max, or null. A refused hit counts on the limit that refused it and on the narrower
 * ones before it (it is a try), never on the wider ones after it.
 */
export async function hit(db: D1Database, now: number, limits: Limit[]): Promise<Refusal | null> {
  if (limits.length === 0) return null
  const results = await db.batch<{ count: number; window_end: number }>(
    limits.map((l, i) =>
      i === 0
        ? db.prepare(UPSERT).bind(l.key, l.windowEnd, now)
        : db
            .prepare(guardedUpsert(limits.slice(0, i)))
            .bind(l.key, l.windowEnd, now, ...limits.slice(0, i).flatMap((p) => [p.key, p.max])),
    ),
  )
  for (let i = 0; i < limits.length; i++) {
    const row = results[i]?.results?.[0]
    const l = limits[i]!
    if (!row) throw new Error('counter upsert returned nothing')
    if (row.count > l.max) return { code: l.code, retryAfter: Math.max(1, row.window_end - now) }
  }
  return null
}

/** The next UTC midnight: daily totals reset there. */
export function endOfDay(now: number): number {
  return (Math.floor(now / DAY) + 1) * DAY
}

export function dayKey(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10)
}

/**
 * The caller's address as a counter key: hashed, never stored raw. IPv6 is keyed by its /64 (one host or one
 * customer line usually holds a whole /64, so a /128 key would let it rotate past every limit: D2 review, finding 3).
 */
export async function addressKey(request: Request): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  return (await sha256hex(`addr:${ip.includes(':') ? ipv6Prefix64(ip) : ip}`)).slice(0, 32)
}

/** The first 4 groups of an IPv6 address, expanded and lower-case (`2001:db8:1:2`); the raw text if it cannot parse. */
export function ipv6Prefix64(ip: string): string {
  const halves = ip.toLowerCase().split('%')[0]!.split('::')
  if (halves.length > 2) return ip
  const groups = (h: string | undefined) => (h ? h.split(':') : [])
  const head = groups(halves[0])
  const tail = groups(halves[1])
  // an embedded IPv4 tail (::ffff:192.0.2.1) takes two groups
  const width = (g: string[]) => g.reduce((n, x) => n + (x.includes('.') ? 2 : 1), 0)
  const fill = halves.length === 2 ? 8 - width(head) - width(tail) : 0
  const all = [...head, ...Array<string>(Math.max(0, fill)).fill('0'), ...tail]
  const first = all.slice(0, 4)
  if (first.length < 4 || first.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip
  return 'v6:' + first.map((g) => g.replace(/^0+(?=.)/, '')).join(':')
}

/** Lazy purge of rows nobody needs any more. Run from routes that create rows (session, state, code). */
export async function purge(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now),
    db.prepare('DELETE FROM handled WHERE expires_at <= ?1').bind(now),
    // day 5: a demo session's spoken drafts go with its other rows (BRIEF-D5 § 3.5)
    db.prepare('DELETE FROM spoken WHERE expires_at <= ?1').bind(now),
    db.prepare('DELETE FROM pair_codes WHERE expires_at <= ?1').bind(now),
    db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?1').bind(now),
    db.prepare('DELETE FROM pair_failures WHERE at <= ?1').bind(now - 600),
    db.prepare('DELETE FROM counters WHERE window_end <= ?1').bind(now),
  ])
}
