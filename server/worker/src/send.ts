// The real send (BRIEF-D4 § 3.2 to 3.4): the ONE Google write the Worker may make, users.messages.send, reached only
// from POST /api/items/<id>/send in paired mode, on a user's press, when REAL_SEND is exactly "on". The recipient is
// computed here from Gmail's own copy of the stored message (job B's senderAlias) and checked against the account's
// self_hash again on the finished message, right before it leaves; never taken from the request, a Reply-To or a
// stored text. The text that leaves is the stored, validated draft or alternative, plus one fixed signature line.
//
// Sources (read 2026-11-23):
// - gmail/api/reference/rest/v1/users.messages/send: « POST https://gmail.googleapis.com/gmail/v1/users/{userId}/
//   messages/send »; « The request body contains an instance of Message »; « If successful, the response body contains
//   an instance of Message »; « Requires one of the following OAuth scopes: … https://www.googleapis.com/auth/gmail.send ».
// - users.messages/get: « GET https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id} »; format « The format
//   to return the message in »; metadataHeaders[] « When given and format is METADATA, only include headers specified ».
// - guides/sending: « The Gmail API requires MIME email messages compliant with RFC 2822 and encoded as base64URL
//   strings »; « Gmail messages are sent as base64URL encoded strings within the raw field of a messages resource ».
// - guides/threads: « The requested threadId must be specified as part of the … messages resource you supply with your
//   request »; « The References and In-Reply-To headers must be set in compliance with the RFC 2822 standard »; « The
//   Subject headers must match ».
// (The Message resource's own page, which describes `raw` and `threadId` field by field, was not among the pages read.)
import { senderAlias } from '../../triage/gmail.ts'
import { base64, base64url, open, seal, sha256hex, tokenKey } from './crypto.ts'
import { type Deps, type Env, MissingConfig, requireConfig } from './env.ts'
import { GoogleError, InvalidGrant, refreshAccessToken, RunCap, RunCapReached, upstreams } from './google.ts'
import { dayKey, endOfDay } from './limits.ts'
import { PERSONAS } from './personas.ts'

export const SIGNATURE = 'Sent from my glasses with Brief'
export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
/** Google calls of one send request, at most (token + get + send, and ONE refresh-and-retry of a 401). */
export const SEND_MAX_CALLS = 6
/** The time limit of each Google call of a send, reading its answer included. */
export const SEND_CALL_LIMIT_MS = 8000
/** The cached access token is used only when MORE than this many seconds are left. */
export const ACCESS_MIN_LEFT_S = 60
export const DEFAULT_SEND_DAILY_CAP = 20
export const SUBJECT_MAX = 200
export const REFERENCES_MAX = 10
/** BRIEF-D4 § 3.3. isMessageId() also asks for printable ASCII: an id with a control or non-ASCII character is « bad ». */
export const MSG_ID_RE = /^<[^<>\s]{1,240}>$/
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const CONTROL = /[\p{Cc}\u2028\u2029]/u
const HEADER_ORDER = ['From', 'To', 'Subject', 'In-Reply-To', 'References', 'Date', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding']
const enc = new TextEncoder()

/** A real mail leaves only when REAL_SEND is exactly "on" (not "ON", not "true"). */
export function realSendOn(env: Env): boolean {
  return env.REAL_SEND === 'on'
}

export function sendDailyCap(env: Env): number {
  const raw = (env.SEND_DAILY_CAP ?? '').trim()
  const n = raw === '' ? DEFAULT_SEND_DAILY_CAP : Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_SEND_DAILY_CAP
}

/** The stored grant's scope (space-separated) holds gmail.send. */
export function hasSendScope(scope: unknown): boolean {
  return typeof scope === 'string' && scope.split(/\s+/).includes(SEND_SCOPE)
}

// ---------------------------------------------------------------------------------------------------------------
// buildReply: ONE pure function (no I/O) that writes the message, then checks the finished text.

/** A definite failure inside buildReply: the code only, never a header value. */
export class ReplyRefused extends Error {
  constructor(readonly code: string) {
    super(`reply refused: ${code}`)
  }
}

export interface ReplyInput {
  /** The account's own address: the alias without its tag. */
  from: string
  /** The plus-alias the stored message came from. */
  to: string
  /** Gmail's copy of the original Subject ('' when it has none). */
  subject: string
  messageId: string | null
  references: string | null
  /** The stored, validated draft or alternative. */
  text: string
  /** Unix seconds (the Date header). */
  now: number
  /** SHA-256 (hex) of the account's lower-cased address. */
  selfHash: string
}

/** Control characters removed, cut at 200 characters, « Re: » in front unless it already starts with re: (any case). */
export function replySubject(original: string): string {
  const clean = original.replace(/[\p{Cc}\u2028\u2029]/gu, '').trim()
  const cut = Array.from(clean).slice(0, SUBJECT_MAX).join('').trim()
  return /^re:/i.test(cut) ? cut : `Re: ${cut}`.trimEnd()
}

export function isMessageId(v: string): boolean {
  return MSG_ID_RE.test(v) && PRINTABLE_ASCII.test(v)
}

/** The ids of a References header, in order; anything that is not a good id is dropped. */
export function referenceIds(v: string): string[] {
  return (v.match(/<[^<>\s]{1,240}>/g) ?? []).filter(isMessageId)
}

/** RFC 2047 encoded-words (UTF-8, base64) of whole characters, 68 characters each (a first line « Subject: » + one word stays within 78), folded with CRLF SP. */
export function encodeWords(v: string): string {
  if (/^[\x20-\x7e]*$/.test(v)) return v
  const words: number[][] = []
  let chunk: number[] = []
  for (const ch of v) {
    const bytes = enc.encode(ch)
    if (chunk.length + bytes.length > 42) {
      words.push(chunk)
      chunk = []
    }
    chunk.push(...bytes)
  }
  if (chunk.length) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${base64(Uint8Array.from(w))}?=`).join('\r\n ')
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** RFC 5322 date-time in UTC: « Mon, 23 Nov 2026 21:30:00 +0000 ». */
export function mailDate(unix: number): string {
  const d = new Date(unix * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
}

/**
 * The reply as an RFC 2822 message with CRLF line ends: the nine headers in their fixed order (In-Reply-To and
 * References only for a good Message-ID), then the body in base64, 76-character lines. Throws ReplyRefused when a
 * header value holds a control character, and when the finished message's To, tag removed and lower-cased, does not
 * hash to selfHash (or its From is not that address, or its headers are not exactly the expected ones).
 */
export async function buildReply(r: ReplyInput): Promise<string> {
  const subject = replySubject(r.subject)
  const id = (r.messageId ?? '').trim()
  const threaded = isMessageId(id)
  const refs = threaded ? [...referenceIds(r.references ?? '').slice(-REFERENCES_MAX), id] : []
  const date = mailDate(r.now)
  // [name, value, value as written]: only the Subject (encoded-words) and References (one id per line) are folded
  const fields: Array<[string, string, string]> = [
    ['From', r.from, r.from],
    ['To', r.to, r.to],
    ['Subject', subject, encodeWords(subject)],
  ]
  if (threaded) fields.push(['In-Reply-To', id, id], ['References', refs.join(' '), refs.join('\r\n ')])
  fields.push(
    ['Date', date, date],
    ['MIME-Version', '1.0', '1.0'],
    ['Content-Type', 'text/plain; charset=UTF-8', 'text/plain; charset=UTF-8'],
    ['Content-Transfer-Encoding', 'base64', 'base64'],
  )
  for (const [, v] of fields) if (CONTROL.test(v)) throw new ReplyRefused('header_control')
  const body = `${r.text.replace(/\r\n|\r|\n/g, '\r\n')}\r\n\r\n-- \r\n${SIGNATURE}`
  const lines = base64(enc.encode(body)).match(/.{1,76}/g) ?? []
  const raw = `${fields.map(([n, , w]) => `${n}: ${w}`).join('\r\n')}\r\n\r\n${lines.join('\r\n')}\r\n`
  await checkFinished(raw, r.selfHash)
  return raw
}

/** The last check, on the finished text, right before the request leaves. */
export async function checkFinished(raw: string, selfHash: string): Promise<void> {
  const end = raw.indexOf('\r\n\r\n')
  if (end < 0) throw new ReplyRefused('shape')
  const fields = raw
    .slice(0, end)
    .replace(/\r\n[ \t]/g, ' ')
    .split('\r\n')
    .map((l): [string, string] => {
      const i = l.indexOf(':')
      return i > 0 ? [l.slice(0, i), l.slice(i + 1).trim()] : ['', l]
    })
  const names = fields.map(([n]) => n)
  const threaded = names.includes('In-Reply-To')
  const want = HEADER_ORDER.filter((n) => threaded || (n !== 'In-Reply-To' && n !== 'References'))
  if (names.join('|') !== want.join('|')) throw new ReplyRefused('headers')
  for (const [, v] of fields) if (CONTROL.test(v)) throw new ReplyRefused('header_control')
  const value = (n: string) => fields.find(([k]) => k === n)?.[1] ?? ''
  // To: exactly ONE address, a plus-alias whose address without the tag, lower-cased, hashes to the account's self_hash
  const m = /^([^\s@+<>,;:"()[\]\\]+)\+([^\s@+<>,;:"()[\]\\]+)@([^\s@<>,;:"()[\]\\]+)$/.exec(value('To'))
  if (!m) throw new ReplyRefused('to')
  const self = `${m[1]}@${m[3]}`.toLowerCase()
  if ((await sha256hex(self)) !== selfHash.toLowerCase()) throw new ReplyRefused('to_hash')
  if (value('From').toLowerCase() !== self) throw new ReplyRefused('from')
  // one text part: base64 lines of 76 characters at most and nothing else
  if (!/^(?:[A-Za-z0-9+/=]{1,76}\r\n)+$/.test(raw.slice(end + 4))) throw new ReplyRefused('body')
}

// ---------------------------------------------------------------------------------------------------------------
// The claim and the outcome in D1. Stored: send_state, sent_id, the times, the choice index. Never a text or address.

export type Claim = { kind: 'claimed'; threadId: string | null; persona: string | null } | { kind: 'daily_cap' | 'already_handled' }

/**
 * g + h. ONE D1 batch (one transaction): the claim is ONE conditional UPDATE (handled + send_state 'sending', only if
 * the row is not handled and the account's real sends of this UTC day are under SEND_DAILY_CAP); the day's count goes
 * up by one only when that UPDATE changed a row (changes() = 1). The count is never given back.
 */
export async function claimSend(db: D1Database, env: Env, accountId: number, msgId: string, choice: number, now: number): Promise<Claim> {
  const cap = sendDailyCap(env)
  const key = `send:${accountId}:${dayKey(now)}`
  const [claimed] = await db.batch<{ thread_id: string | null; persona: string | null }>([
    db
      .prepare(
        `UPDATE messages SET handled_at = ?3, handled_action = 'send', handled_choice = ?4, send_state = 'sending', sent_id = NULL
         WHERE account_id = ?1 AND msg_id = ?2 AND state = 'done' AND handled_at IS NULL
           AND COALESCE((SELECT count FROM counters WHERE key = ?5 AND window_end > ?3), 0) < ?6
         RETURNING thread_id, persona`,
      )
      .bind(accountId, msgId, now, choice, key, cap),
    db
      .prepare(
        `INSERT INTO counters (key, count, window_end) SELECT ?1, 1, ?2 WHERE changes() = 1
         ON CONFLICT (key) DO UPDATE SET count = counters.count + 1`,
      )
      .bind(key, endOfDay(now)),
  ])
  const row = claimed?.results?.[0]
  if (row) return { kind: 'claimed', threadId: row.thread_id, persona: row.persona }
  const used = await db.prepare('SELECT count FROM counters WHERE key = ?1 AND window_end > ?2').bind(key, now).first<{ count: number }>()
  return (used?.count ?? 0) >= cap ? { kind: 'daily_cap' } : { kind: 'already_handled' }
}

/** A definite failure: the claim is released, the row is unhandled again and the item is offered again. */
export async function releaseSend(db: D1Database, accountId: number, msgId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE messages SET handled_at = NULL, handled_action = NULL, handled_choice = NULL, send_state = NULL, sent_id = NULL
       WHERE account_id = ?1 AND msg_id = ?2 AND send_state = 'sending'`,
    )
    .bind(accountId, msgId)
    .run()
}

/** sent (with Gmail's id) or unknown: the row stays handled for good. */
export async function finishSend(db: D1Database, accountId: number, msgId: string, state: 'sent' | 'unknown', sentId: string | null): Promise<void> {
  await db
    .prepare(`UPDATE messages SET send_state = ?3, sent_id = ?4 WHERE account_id = ?1 AND msg_id = ?2 AND send_state = 'sending'`)
    .bind(accountId, msgId, state, sentId)
    .run()
}

// ---------------------------------------------------------------------------------------------------------------
// i. The Google calls of one send.

export interface SendAccount {
  id: number
  email_hash: string
  self_hash: string
  refresh_iv: string
  refresh_ct: string
  access_iv: string | null
  access_ct: string | null
  access_expires_at: number | null
}

export type SendOutcome =
  | { kind: 'sent'; sentId: string }
  | { kind: 'failed'; step: string; status?: number }
  | { kind: 'unknown'; step: string; status?: number }
  | { kind: 'signin' }

class CallTimeout extends Error {
  constructor() {
    super('time limit')
  }
}

/** One call through deps.fetch with its time limit; the answer is read inside the limit too (no hang after it). */
async function limitedFetch(deps: Deps, ms: number, url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort()
      reject(new CallTimeout())
    }, ms)
  })
  try {
    return await Promise.race([
      (async () => {
        const res = await deps.fetch(url, { ...init, signal: ac.signal })
        const buf = await res.arrayBuffer()
        const noBody = res.status === 204 || res.status === 205 || res.status === 304
        return new Response(noBody ? null : buf, { status: res.status, headers: res.headers })
      })(),
      timeout,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function stepOf(e: unknown): string {
  if (e instanceof RunCapReached) return 'cap'
  if (e instanceof CallTimeout) return 'timeout'
  if (e instanceof ReplyRefused) return `build.${e.code}`
  if (e instanceof MissingConfig) return 'config'
  if (e instanceof GoogleError) return e.step
  return 'error'
}

interface Header {
  name: string
  value: string
}

/**
 * The Google calls of ONE send, exactly: (1) an access token (the cached sealed one when more than 60 s are left,
 * else one refresh, stored sealed as the sync does), (2) users.messages.get of THIS id with format=metadata,
 * (3) users.messages.send. Each through deps.fetch, counted (6 at most), each with its time limit. The first 401 on
 * call 2 or 3 → one refresh and one retry of that call; any further 401 = a definite failure.
 * Outcome: sent · failed (definite: nothing left) · unknown (call 3 may have left) · signin (invalid_grant).
 */
export async function sendReply(
  env: Env,
  deps: Deps,
  a: SendAccount,
  msg: { id: string; threadId: string | null; persona: string | null },
  text: string,
): Promise<{ outcome: SendOutcome; calls: number }> {
  const cap = new RunCap(SEND_MAX_CALLS)
  const ms = deps.sendCallLimitMs ?? SEND_CALL_LIMIT_MS
  const lim: Deps = { ...deps, fetch: (u, i) => limitedFetch(deps, ms, u, i ?? {}) }
  const up = upstreams(env)
  const done = (outcome: SendOutcome) => ({ outcome, calls: cap.used })
  let left = false // true from the moment call 3 may have left
  let retried = false // the ONE refresh-and-retry of a 401 on call 2 or 3
  try {
    requireConfig(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TOKEN_KEY'])
    const threadId = msg.threadId
    if (!threadId || !THREAD_ID_RE.test(threadId) || !msg.persona) return done({ kind: 'failed', step: 'row' })
    const key = await tokenKey(env.TOKEN_KEY!)
    const aad = `access:${a.email_hash}`
    const refresh = async (): Promise<string> => {
      const rt = await open(key, { iv: a.refresh_iv, ct: a.refresh_ct }, a.email_hash)
      const t = await refreshAccessToken(lim, up, cap, { id: env.GOOGLE_CLIENT_ID!, secret: env.GOOGLE_CLIENT_SECRET! }, rt)
      const sealed = await seal(key, t.accessToken, aad)
      await env.DB.prepare('UPDATE accounts SET access_iv = ?2, access_ct = ?3, access_expires_at = ?4 WHERE id = ?1')
        .bind(a.id, sealed.iv, sealed.ct, deps.now() + t.expiresIn)
        .run()
      return t.accessToken
    }

    // 1. the access token
    let token: string | null = null
    if (a.access_iv && a.access_ct && (a.access_expires_at ?? 0) - deps.now() > ACCESS_MIN_LEFT_S) {
      try {
        token = await open(key, { iv: a.access_iv, ct: a.access_ct }, aad)
      } catch {
        token = null // unreadable (key rotated): one refresh
      }
    }
    token ??= await refresh()

    // 2. Gmail's copy of THIS message: the four headers only
    const q = new URLSearchParams([['format', 'metadata'], ...['From', 'Subject', 'Message-ID', 'References'].map((h) => ['metadataHeaders', h])])
    const getUrl = `${up.gmailBase}/gmail/v1/users/me/messages/${encodeURIComponent(msg.id)}?${q}`
    const get = async () => {
      cap.take()
      return lim.fetch(getUrl, { method: 'GET', headers: { authorization: `Bearer ${token}` }, redirect: 'manual' })
    }
    let res = await get()
    if (res.status === 401 && !retried) {
      retried = true
      token = await refresh()
      res = await get()
    }
    if (res.status !== 200) return done({ kind: 'failed', step: 'gmail.get', status: res.status })
    let copy: { id?: unknown; payload?: { headers?: unknown } }
    try {
      copy = (await res.json()) as typeof copy
    } catch {
      return done({ kind: 'failed', step: 'gmail.get', status: 200 })
    }
    const raw = copy?.payload?.headers
    if (copy?.id !== msg.id || !Array.isArray(raw)) return done({ kind: 'failed', step: 'gmail.get', status: 200 })
    const headers: Header[] = raw.filter(
      (h): h is Header => typeof h === 'object' && h !== null && typeof (h as Header).name === 'string' && typeof (h as Header).value === 'string',
    )
    // the sender gate of the sync, on Gmail's copy NOW: the same persona as the stored row, else nothing leaves
    const who = await senderAlias(headers, a.self_hash, PERSONAS ?? [])
    if (!who || who.persona.key !== msg.persona) return done({ kind: 'failed', step: 'sender' })
    const named = (n: string) => headers.filter((h) => h.name.toLowerCase() === n)
    const subjects = named('subject')
    if (subjects.length > 1) return done({ kind: 'failed', step: 'subject' })
    const ids = named('message-id')
    const refs = named('references')

    // 3. the send: the finished message is checked by buildReply right before it leaves
    const message = await buildReply({
      from: who.self,
      to: who.alias,
      subject: subjects[0]?.value ?? '',
      messageId: ids.length === 1 ? ids[0]!.value : null,
      references: refs.length === 1 ? refs[0]!.value : null,
      text,
      now: deps.now(),
      selfHash: a.self_hash,
    })
    const body = JSON.stringify({ raw: base64url(enc.encode(message)), threadId })
    const sendUrl = `${up.gmailBase}/gmail/v1/users/me/messages/send`
    const post = async (): Promise<SendOutcome | 'retry'> => {
      cap.take() // at the cap it throws BEFORE leaving: a definite failure
      left = true
      let r: Response
      try {
        r = await lim.fetch(sendUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body,
          redirect: 'manual',
        })
      } catch {
        return { kind: 'unknown', step: 'gmail.send' } // its time limit or a network error: it may have left
      }
      if (r.status === 401 && !retried) return 'retry'
      if (r.status >= 400 && r.status < 500) return { kind: 'failed', step: 'gmail.send', status: r.status }
      if (r.status === 200) {
        let sentId: unknown
        try {
          sentId = ((await r.json()) as { id?: unknown }).id
        } catch {
          sentId = undefined
        }
        if (typeof sentId === 'string' && SENT_ID_RE.test(sentId)) return { kind: 'sent', sentId }
      }
      return { kind: 'unknown', step: 'gmail.send', status: r.status } // a 5xx, a 200 with no id, anything else
    }
    let out = await post()
    if (out === 'retry') {
      retried = true
      left = false // a 401 = refused: nothing left; the retry has not left yet
      token = await refresh()
      out = await post()
    }
    return done(out === 'retry' ? { kind: 'failed', step: 'gmail.send', status: 401 } : out)
  } catch (e) {
    if (e instanceof InvalidGrant) {
      // only a new sign-in (which replaces the refresh token) clears this
      await env.DB.prepare('UPDATE accounts SET needs_signin = 1, access_iv = NULL, access_ct = NULL, access_expires_at = NULL WHERE id = ?1')
        .bind(a.id)
        .run()
      return done({ kind: 'signin' })
    }
    return done(left ? { kind: 'unknown', step: stepOf(e) } : { kind: 'failed', step: stepOf(e) })
  }
}
