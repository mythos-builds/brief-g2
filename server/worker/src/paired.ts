// Paired mode (BRIEF-D3 § 3.2 to 3.4): every route only READS what the sync stored. A stored triage result or brief
// that fails today's validation is never served. The API never returns a real address: Item.address is the persona's
// fictional one from the bundled table.
import { checkShape } from '../../triage/validate.ts'
import { sha256hex } from './crypto.ts'
import { allowedAccounts, type Env } from './env.ts'
import type { Item } from './items.ts'
import { type CalendarEvent, displayTz, hhmm, localDate, personaOf } from './personas.ts'
import { hasSendScope, realSendOn, type SendAccount } from './send.ts'
import { validBrief } from './wiring.ts'

export const ITEMS_MAX = 20

/** The email_hash (SHA-256 of `email:<lower-cased address>`) of every address of today's ALLOWED_ACCOUNTS. */
export async function allowedHashes(env: Env): Promise<Set<string>> {
  const out = new Set<string>()
  for (const e of allowedAccounts(env)) out.add(await sha256hex(`email:${e}`))
  return out
}

export interface AccountRow extends SendAccount {
  scope: string
  needs_signin: number
}

/**
 * Check b of BRIEF-D4 § 3.2, for every paired route: the account is in TODAY's ALLOWED_ACCOUNTS (else 401: refuse,
 * never revoke, never delete, decision 1.6) · its grant is alive (else 403 signin_needed) · for send and skip, when
 * REAL_SEND is on, its stored scope holds gmail.send (else 403 signin_needed).
 */
export async function accountGate(
  env: Env,
  accountId: number | null,
  sendScope: boolean,
): Promise<{ account: AccountRow } | { error: 'unauthorized' | 'signin_needed' }> {
  const row =
    accountId === null
      ? null
      : await env.DB.prepare(
          `SELECT id, email_hash, self_hash, scope, needs_signin, refresh_iv, refresh_ct, access_iv, access_ct, access_expires_at
           FROM accounts WHERE id = ?1`,
        )
          .bind(accountId)
          .first<AccountRow>()
  if (!row || !(await allowedHashes(env)).has(row.email_hash)) return { error: 'unauthorized' }
  if (row.needs_signin !== 0 || !row.self_hash) return { error: 'signin_needed' }
  if (sendScope && realSendOn(env) && !hasSendScope(row.scope)) return { error: 'signin_needed' }
  return { account: row }
}

/** The account's grant state: 'ok', or 'signin' when it is dead (or the account is gone). */
export async function grantState(db: D1Database, accountId: number | null): Promise<'ok' | 'signin'> {
  if (accountId === null) return 'signin'
  const row = await db.prepare('SELECT needs_signin FROM accounts WHERE id = ?1').bind(accountId).first<{ needs_signin: number }>()
  return row && row.needs_signin === 0 ? 'ok' : 'signin'
}

interface Row {
  msg_id: string
  persona: string | null
  received_at: number | null
  result: string
  handled_at: number | null
}

/** A stored row → the Item, or null when anything fails the checks (result, needs_reply, persona, id). */
function toItem(r: Row, tz: string): Item | null {
  const persona = personaOf(r.persona)
  if (!persona || typeof r.received_at !== 'number' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.msg_id)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(r.result)
  } catch {
    return null
  }
  const checked = checkShape(parsed)
  if (!checked.ok || !checked.value.needs_reply) return null
  return {
    id: r.msg_id,
    source: 'mail',
    persona: persona.key,
    name: persona.name,
    fullName: persona.fullName,
    address: persona.address,
    at: hhmm(r.received_at, tz),
    summary: checked.value.summary,
    draft: checked.value.draft,
    alts: checked.value.alts,
  }
}

// a row handled for a real send (sending, sent, unknown) has handled_at set: never listed, never offered again
const SELECT = `SELECT m.msg_id, m.persona, m.received_at, m.handled_at, r.result
  FROM messages m JOIN triage_results r ON r.id = m.account_id || ':' || m.msg_id
  WHERE m.account_id = ?1 AND m.state = 'done'`

/** This account's stored messages that need a reply and are not handled, newest first, 20 at most. */
export async function pairedItems(env: Env, accountId: number): Promise<Item[]> {
  const tz = displayTz(env.DISPLAY_TZ)
  const rows = await env.DB.prepare(`${SELECT} AND m.handled_at IS NULL ORDER BY m.received_at DESC, m.msg_id LIMIT 100`)
    .bind(accountId)
    .all<Row>()
  const out: Item[] = []
  for (const r of rows.results) {
    const it = toItem(r, tz)
    if (it) out.push(it)
    if (out.length === ITEMS_MAX) break
  }
  return out
}

/** One stored item of the account (handled or not), or null when it is unknown or not servable. */
export async function pairedItem(env: Env, accountId: number, id: string): Promise<{ item: Item; handled: boolean } | null> {
  const r = await env.DB.prepare(`${SELECT} AND m.msg_id = ?2`).bind(accountId, id).first<Row>()
  if (!r) return null
  const item = toItem(r, displayTz(env.DISPLAY_TZ))
  return item ? { item, handled: r.handled_at !== null } : null
}

/** « Handled » for the ACCOUNT in ONE conditional update: of two racing requests (any sessions) one wins. */
export async function markPairedHandled(
  db: D1Database,
  accountId: number,
  id: string,
  action: 'send' | 'skip',
  choice: number | null,
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE messages SET handled_at = ?3, handled_action = ?4, handled_choice = ?5
       WHERE account_id = ?1 AND msg_id = ?2 AND handled_at IS NULL RETURNING 1 AS ok`,
    )
    .bind(accountId, id, now, action, choice)
    .first()
  return row !== null
}

/** Today's stored events of the account that start after now, in order, 5 at most (§ 3.4). */
export async function pairedCalendar(env: Env, accountId: number, now: number): Promise<{ now: string; events: CalendarEvent[] }> {
  const tz = displayTz(env.DISPLAY_TZ)
  const today = localDate(now, tz)
  const rows = await env.DB.prepare(
    'SELECT start_at, title, persona, brief FROM events WHERE account_id = ?1 AND start_at > ?2 ORDER BY start_at, event_id LIMIT 20',
  )
    .bind(accountId, now)
    .all<{ start_at: number; title: string; persona: string | null; brief: string | null }>()
  const events: CalendarEvent[] = []
  for (const r of rows.results) {
    if (localDate(r.start_at, tz) !== today) continue
    const title = typeof r.title === 'string' ? r.title.trim() : ''
    if (title === '' || title.length > 60 || /[\r\n]/.test(title)) continue
    const p = personaOf(r.persona)
    const ev: CalendarEvent = { start: hhmm(r.start_at, tz), title, who: p ? `${p.fullName}, ${p.company}` : '' }
    if (r.brief) {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(r.brief)
      } catch {
        parsed = null
      }
      const b = validBrief(parsed)
      if (b) ev.brief = { why: b.why, last: b.last, facts: [...b.facts] }
    }
    events.push(ev)
    if (events.length === 5) break
  }
  return { now: hhmm(now, tz), events }
}
