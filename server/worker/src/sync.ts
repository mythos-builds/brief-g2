// The sync (BRIEF-D3 § 3.5): runs from the `scheduled` handler only, never from a route. For each account whose grant
// is alive: an access token (cached sealed), the label id, up to 5 new messages triaged ONCE, the calendar's next 24 h,
// up to 2 meeting briefs. 40 outgoing requests per run at most (Google and model together); at the cap it stops
// cleanly. Logs: step names, counts and codes only; never a body, a subject, an address or a token.
import type { BriefInput, BriefResult } from '../../triage/brief.ts'
import { allBudgets, dailyBudget, dayKey } from '../../triage/budget.ts'
import type { SeenMail } from '../../triage/gmail.ts'
import { DEFAULT_DEADLINE_MS } from '../../triage/chain.ts'
import { triageOnce } from '../../triage/once.ts'
import type { FetchLike, MailItem, RequestBudget, TriageOptions } from '../../triage/types.ts'
import { safeText } from '../../triage/validate.ts'
import { open, seal, sha256hex, tokenKey } from './crypto.ts'
import { type Deps, type Env, MissingConfig, requireConfig } from './env.ts'
import {
  GoogleClient,
  GoogleError,
  InvalidGrant,
  type RawEvent,
  refreshAccessToken,
  RunCap,
  RunCapReached,
  type Upstreams,
  upstreams,
} from './google.ts'
import { displayTz, hhmm, PERSONAS, type Persona } from './personas.ts'
import { counterValue, d1CounterStore, d1ResultStore } from './stores.ts'

/** Job B's two modules, with the exact signatures of BRIEF-D3 § 3.6 (wiring.ts passes the real ones). */
export interface SyncModules {
  fromGmail(msg: unknown, selfHash: string, personas: Persona[]): Promise<SeenMail | null>
  meetingBrief(input: BriefInput, opts?: TriageOptions): Promise<BriefResult>
  validBrief(v: unknown): BriefResult | null
}

export const RUN_MAX_REQUESTS = 40
export const NEW_PER_RUN = 5
export const BRIEFS_PER_RUN = 2
export const MAX_TRIES = 3
export const TOKEN_MARGIN = 300 // renew the access token when under 5 minutes are left
export const LEASE = 300 // a claim older than this is abandoned (a run that died)
export const DEFAULT_DAILY_CAP = 30
// D3 review, finding 3: a scheduled run must end well inside the platform's wall-time limit for a cron that runs
// more often than hourly (the reviewer remembers 30 s; NOT CHECKED, no network). No new model call starts after
// MODEL_START_BEFORE_S seconds of run; each model call gets a deadline that ends the run by RUN_WALL_S. What is left
// waits for the next run (2 minutes later), unclaimed.
export const RUN_WALL_S = 25
export const MODEL_START_BEFORE_S = 15
const DAY_PREFIX = 'triage'

export interface SyncReport {
  accounts: number
  requests: number
  capped: boolean
  triaged: number
  ignored: number
  failed: number
  events: number
  briefs: number
  signin: number
  /** true = the run stopped starting model calls at MODEL_START_BEFORE_S; the rest waits for the next run. */
  late: boolean
}

interface AccountRow {
  id: number
  email_hash: string
  self_hash: string
  refresh_iv: string
  refresh_ct: string
  access_iv: string | null
  access_ct: string | null
  access_expires_at: number | null
  label_id: string | null
}

function slog(step: string, fields: Record<string, string | number | boolean> = {}): void {
  console.log(JSON.stringify({ route: `sync.${step}`, ...fields }))
}

export function dailyCap(env: Env): number {
  const n = Number((env.TRIAGE_DAILY_CAP ?? '').trim() || DEFAULT_DAILY_CAP)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP
}

/** The NAME of the model key the provider needs, when it is absent; null = present. */
export function missingModelKey(env: Env): string | null {
  const provider = (env.MODEL_PROVIDER ?? 'openrouter').trim().toLowerCase()
  const name = provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY'
  const v = env[name]
  return typeof v === 'string' && v.trim() !== '' ? null : name
}

/** `<base>+<tag>@<domain>` of the account (hash of `<base>@<domain>` = selfHash) with a persona tag → that persona. */
export async function aliasPersona(address: unknown, selfHash: string, personas: Persona[]): Promise<Persona | null> {
  if (typeof address !== 'string') return null
  const m = /^([^\s@+]+)\+([^\s@+]+)@([^\s@]+)$/.exec(address.trim().toLowerCase())
  if (!m) return null
  const persona = personas.find((p) => p.key === m[2])
  if (!persona) return null
  return (await sha256hex(`${m[1]}@${m[3]}`)) === selfHash ? persona : null
}

class Run {
  readonly cap: RunCap
  readonly up: Upstreams
  readonly tz: string
  readonly report: SyncReport
  key!: CryptoKey
  readonly startedAt: number

  constructor(
    readonly env: Env,
    readonly deps: Deps,
    readonly mods: SyncModules,
    max: number,
  ) {
    this.cap = new RunCap(max)
    this.up = upstreams(env)
    this.tz = displayTz(env.DISPLAY_TZ)
    this.report = { accounts: 0, requests: 0, capped: false, triaged: 0, ignored: 0, failed: 0, events: 0, briefs: 0, signin: 0, late: false }
    this.startedAt = deps.now()
  }

  /** The deadline (ms) a new model call may use, or null = too late in this run to start one (finding 3). */
  modelDeadlineMs(): number | null {
    const elapsed = this.deps.now() - this.startedAt
    if (elapsed >= MODEL_START_BEFORE_S) {
      if (!this.report.late) slog('deadline', { seconds: elapsed })
      this.report.late = true
      return null
    }
    return Math.min(DEFAULT_DEADLINE_MS, (RUN_WALL_S - elapsed) * 1000)
  }

  get db(): D1Database {
    return this.env.DB
  }

  /** Model requests: the run's cap first, then the daily cap in D1 (checked BEFORE each request). */
  modelOpts(): TriageOptions {
    const run: RequestBudget = { take: async () => this.cap.tryTake() }
    const daily = dailyBudget(d1CounterStore(this.db, this.deps.now), dailyCap(this.env), () => this.deps.now() * 1000, DAY_PREFIX)
    const fetch: FetchLike = async (url, init) => {
      const res = await this.deps.fetch(url, init)
      return { status: res.status, text: () => res.text() }
    }
    return {
      budget: allBudgets(run, daily),
      fetch,
      now: () => this.deps.now() * 1000,
      env: {
        MODEL_PROVIDER: this.env.MODEL_PROVIDER,
        OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
        ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
        CLAUDE_MODEL: this.env.CLAUDE_MODEL,
      },
      ...(this.up.modelBase ? { baseUrl: this.up.modelBase } : {}),
    }
  }

  async dailyLeft(): Promise<number> {
    return dailyCap(this.env) - (await counterValue(this.db, dayKey(DAY_PREFIX, this.deps.now() * 1000)))
  }

  /** a. An access token: the cached one while 5 minutes or more are left, else a refresh. null = dead grant. */
  async accessToken(a: AccountRow): Promise<string | null> {
    const now = this.deps.now()
    const aad = `access:${a.email_hash}`
    if (a.access_iv && a.access_ct && (a.access_expires_at ?? 0) - now >= TOKEN_MARGIN) {
      try {
        return await open(this.key, { iv: a.access_iv, ct: a.access_ct }, aad)
      } catch {
        // unreadable (key rotated): refresh below
      }
    }
    const refresh = await open(this.key, { iv: a.refresh_iv, ct: a.refresh_ct }, a.email_hash)
    try {
      const t = await refreshAccessToken(
        this.deps,
        this.up,
        this.cap,
        { id: this.env.GOOGLE_CLIENT_ID!, secret: this.env.GOOGLE_CLIENT_SECRET! },
        refresh,
      )
      const sealed = await seal(this.key, t.accessToken, aad)
      await this.db
        .prepare('UPDATE accounts SET access_iv = ?2, access_ct = ?3, access_expires_at = ?4 WHERE id = ?1')
        .bind(a.id, sealed.iv, sealed.ct, now + t.expiresIn)
        .run()
      return t.accessToken
    } catch (e) {
      if (!(e instanceof InvalidGrant)) throw e
      // only a new sign-in (which replaces the refresh token) clears this
      await this.db
        .prepare('UPDATE accounts SET needs_signin = 1, access_iv = NULL, access_ct = NULL, access_expires_at = NULL WHERE id = ?1')
        .bind(a.id)
        .run()
      this.report.signin += 1
      slog('signin_needed', { account: a.id })
      return null
    }
  }

  /**
   * b. The id of the label named exactly DEMO_LABEL, looked up on EVERY run (D3 review, finding 4: a cached id would
   * keep reading a label renamed away from DEMO_LABEL). The cached column follows what Google answers now.
   */
  async labelId(a: AccountRow, g: GoogleClient): Promise<string | null> {
    const name = (this.env.DEMO_LABEL ?? '').trim()
    if (!name) {
      slog('label', { missing: 'DEMO_LABEL' })
      return null
    }
    const found = (await g.labels()).find((l) => l.name === name)
    const id = found ? found.id : null
    if (id !== a.label_id) await this.db.prepare('UPDATE accounts SET label_id = ?2 WHERE id = ?1').bind(a.id, id).run()
    if (!found) {
      slog('label', { found: 0 })
      return null
    }
    return found.id
  }

  /** c. Up to 5 messages not yet stored: get → fromGmail → ignored, or claimed → triageOnce → done. */
  async messages(a: AccountRow, g: GoogleClient, ids: string[], canTriage: boolean): Promise<void> {
    if (!canTriage || ids.length === 0) return
    const now = this.deps.now()
    const rows = await this.db
      .prepare(
        `SELECT msg_id, state, tries, lease_until FROM messages WHERE account_id = ?1 AND msg_id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`,
      )
      .bind(a.id, ...ids)
      .all<{ msg_id: string; state: string; tries: number; lease_until: number | null }>()
    const known = new Map(rows.results.map((r) => [r.msg_id, r]))
    const todo = ids
      .filter((id) => {
        const r = known.get(id)
        if (!r) return true
        if (r.tries >= MAX_TRIES) return false
        return r.state === 'retry' || (r.state === 'claimed' && (r.lease_until ?? 0) <= now)
      })
      .slice(0, NEW_PER_RUN)
    if (todo.length === 0) return
    const personas = PERSONAS ?? []
    const store = d1ResultStore(this.db, this.deps.now)
    const opts = this.modelOpts()
    for (const id of todo) {
      const deadlineMs = this.modelDeadlineMs()
      if (deadlineMs === null) return
      const seen = await this.mods.fromGmail(await g.message(id), a.self_hash, personas)
      const t = this.deps.now()
      if (!seen || seen.id !== id || !personas.some((p) => p.key === seen.persona.key)) {
        await this.db
          .prepare(
            `INSERT INTO messages (account_id, msg_id, state, created_at) VALUES (?1, ?2, 'ignored', ?3)
             ON CONFLICT (account_id, msg_id) DO NOTHING`,
          )
          .bind(a.id, id, t)
          .run()
        this.report.ignored += 1
        continue
      }
      // claimed atomically: of two runs at the same moment, one gets a row back, the other skips the message
      const claim = await this.db
        .prepare(
          `INSERT INTO messages (account_id, msg_id, thread_id, persona, received_at, state, tries, lease_until, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'claimed', 1, ?6, ?7)
           ON CONFLICT (account_id, msg_id) DO UPDATE SET state = 'claimed', tries = messages.tries + 1, lease_until = ?6,
             thread_id = ?3, persona = ?4, received_at = ?5
           WHERE messages.tries < ${MAX_TRIES}
             AND (messages.state = 'retry' OR (messages.state = 'claimed' AND messages.lease_until <= ?7))
           RETURNING tries`,
        )
        .bind(a.id, id, seen.threadId.slice(0, 128), seen.persona.key, Math.floor(seen.receivedAt), t + LEASE, t)
        .first<{ tries: number }>()
      if (!claim) continue
      try {
        await triageOnce(`${a.id}:${id}`, seen.item, store, { ...opts, deadlineMs })
        await this.db
          .prepare("UPDATE messages SET state = 'done', lease_until = NULL WHERE account_id = ?1 AND msg_id = ?2")
          .bind(a.id, id)
          .run()
        this.report.triaged += 1
      } catch (e) {
        const code = (e as { code?: unknown }).code
        if (code === 'budget_exhausted') {
          // not a real try: the run's cap or the daily cap said no before any request
          await this.db
            .prepare("UPDATE messages SET state = 'retry', tries = tries - 1, lease_until = NULL WHERE account_id = ?1 AND msg_id = ?2")
            .bind(a.id, id)
            .run()
          if (this.cap.used >= this.cap.max) throw new RunCapReached()
          slog('daily_cap', { account: a.id })
          return
        }
        await this.db
          .prepare(
            `UPDATE messages SET state = CASE WHEN tries >= ${MAX_TRIES} THEN 'failed' ELSE 'retry' END, lease_until = NULL
             WHERE account_id = ?1 AND msg_id = ?2`,
          )
          .bind(a.id, id)
          .run()
        this.report.failed += 1
        slog('triage_failed', { account: a.id, code: typeof code === 'string' ? code : 'error' })
      }
    }
  }

  /** d. The next 24 h of `primary`: only events the account created, a safe title, the persona of the first alias. */
  async calendar(a: AccountRow, g: GoogleClient): Promise<void> {
    const now = this.deps.now()
    const items = await g.events(now, now + 86_400)
    const kept: Array<{ id: string; start: number; title: string; persona: string | null }> = []
    for (const e of items as RawEvent[]) {
      if (!e || typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(e.id)) continue
      if (e.status === 'cancelled') continue
      if (e.creator?.self !== true && e.organizer?.self !== true) continue // an outsider's invitation never gets in
      // D3 review, note 7: an event Google made from a mail (fromGmail…) has an outsider's title; only plain events
      if (e.eventType !== undefined && e.eventType !== 'default') continue
      const startRaw = e.start?.dateTime
      if (typeof startRaw !== 'string') continue // an all-day event has no HH:MM
      const start = Math.floor(Date.parse(startRaw) / 1000)
      if (!Number.isFinite(start)) continue
      if (typeof e.summary !== 'string') continue
      // D3 review, note 13: cut by whole characters to a .length of 60 (UTF-16 units, what the routes and the app check)
      let title = ''
      for (const ch of e.summary.normalize('NFKC').trim()) {
        if (title.length + ch.length > 60) break
        title += ch
      }
      title = title.trim()
      if (title === '' || /[\r\n]/.test(title) || !safeText(title, false).ok) continue
      let persona: string | null = null
      for (const at of Array.isArray(e.attendees) ? e.attendees : []) {
        const p = await aliasPersona(at?.email, a.self_hash, PERSONAS ?? [])
        if (p) {
          persona = p.key
          break
        }
      }
      kept.push({ id: e.id, start, title, persona })
    }
    const stmts = kept.map((k) =>
      this.db
        .prepare(
          `INSERT INTO events (account_id, event_id, start_at, title, persona, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (account_id, event_id) DO UPDATE SET start_at = ?3, title = ?4, synced_at = ?6,
             brief = CASE WHEN events.persona IS ?5 THEN events.brief ELSE NULL END,
             brief_tries = CASE WHEN events.persona IS ?5 THEN events.brief_tries ELSE 0 END,
             persona = ?5`,
        )
        .bind(a.id, k.id, k.start, k.title, k.persona, now),
    )
    // what Google no longer lists (moved, deleted, past) leaves the table
    stmts.push(
      this.db
        .prepare(
          `DELETE FROM events WHERE account_id = ?1${kept.length ? ` AND event_id NOT IN (${kept.map((_, i) => `?${i + 2}`).join(',')})` : ''}`,
        )
        .bind(a.id, ...kept.map((k) => k.id)),
    )
    await this.db.batch(stmts)
    this.report.events += kept.length
  }

  /** Up to 2 briefs per run: an event with a persona and no brief → that persona's last 3 mails of the label. */
  async briefs(a: AccountRow, g: GoogleClient, listed: string[], canTriage: boolean): Promise<void> {
    if (!canTriage || listed.length === 0) return
    const now = this.deps.now()
    const due = await this.db
      .prepare(
        `SELECT event_id, start_at, title, persona FROM events
         WHERE account_id = ?1 AND persona IS NOT NULL AND brief IS NULL AND brief_tries < ${MAX_TRIES} AND start_at > ?2
           AND (brief_lease_until IS NULL OR brief_lease_until <= ?2)
         ORDER BY start_at LIMIT ${BRIEFS_PER_RUN}`,
      )
      .bind(a.id, now)
      .all<{ event_id: string; start_at: number; title: string; persona: string }>()
    const opts = this.modelOpts()
    for (const ev of due.results) {
      const persona = (PERSONAS ?? []).find((p) => p.key === ev.persona)
      if (!persona) continue
      const rows = await this.db
        .prepare(
          `SELECT msg_id FROM messages WHERE account_id = ?1 AND persona = ?2 AND state != 'ignored' ORDER BY received_at DESC`,
        )
        .bind(a.id, persona.key)
        .all<{ msg_id: string }>()
      const ids = rows.results.map((r) => r.msg_id).filter((id) => listed.includes(id)).slice(0, 3)
      if (ids.length === 0) continue
      const deadlineMs = this.modelDeadlineMs()
      if (deadlineMs === null) return
      const claim = await this.db
        .prepare(
          `UPDATE events SET brief_tries = brief_tries + 1, brief_lease_until = ?3
           WHERE account_id = ?1 AND event_id = ?2 AND brief IS NULL AND brief_tries < ${MAX_TRIES}
             AND (brief_lease_until IS NULL OR brief_lease_until <= ?4)
           RETURNING brief_tries`,
        )
        .bind(a.id, ev.event_id, now + LEASE, now)
        .first()
      if (!claim) continue
      const mails: MailItem[] = []
      for (const id of ids) {
        const seen = await this.mods.fromGmail(await g.message(id), a.self_hash, PERSONAS ?? [])
        if (seen && seen.persona.key === persona.key) mails.push(seen.item)
      }
      const release = (undo: boolean) =>
        this.db
          .prepare(
            `UPDATE events SET brief_lease_until = NULL${undo ? ', brief_tries = brief_tries - 1' : ''} WHERE account_id = ?1 AND event_id = ?2`,
          )
          .bind(a.id, ev.event_id)
          .run()
      if (mails.length === 0) {
        await release(true)
        continue
      }
      try {
        const answer = await this.mods.meetingBrief(
          { title: ev.title, start: hhmm(ev.start_at, this.tz), persona, mails },
          { ...opts, deadlineMs },
        )
        const valid = this.mods.validBrief(answer)
        if (!valid) {
          await release(false)
          slog('brief_invalid', { account: a.id })
          continue
        }
        await this.db
          .prepare('UPDATE events SET brief = ?3, brief_lease_until = NULL WHERE account_id = ?1 AND event_id = ?2')
          .bind(a.id, ev.event_id, JSON.stringify({ why: valid.why, last: valid.last, facts: valid.facts }))
          .run()
        this.report.briefs += 1
      } catch (e) {
        const code = (e as { code?: unknown }).code
        await release(code === 'budget_exhausted')
        if (code === 'budget_exhausted') {
          if (this.cap.used >= this.cap.max) throw new RunCapReached()
          return
        }
        slog('brief_failed', { account: a.id, code: typeof code === 'string' ? code : 'error' })
      }
    }
  }

  async account(a: AccountRow, canTriage: boolean): Promise<void> {
    const token = await this.accessToken(a)
    if (!token) return
    const g = new GoogleClient(this.deps, this.up, this.cap, token)
    let listed: string[] = []
    try {
      const label = await this.labelId(a, g)
      if (label) listed = await g.messageIds(label)
      // D3 review, finding 3: the calendar (cheap, no model) first, so the header and screen E never wait for triage
      try {
        await this.calendar(a, g)
      } catch (e) {
        // a calendar refusal (scope, API off) never blocks the mail; a dead token (401) or the run cap still stop here
        if (!(e instanceof GoogleError) || e.status === 401) throw e
        slog('calendar_error', { account: a.id, code: `${e.step} ${e.status}` })
      }
      if (label) await this.messages(a, g, listed, canTriage)
      await this.briefs(a, g, listed, canTriage)
    } catch (e) {
      if (e instanceof GoogleError) {
        if (e.status === 401) {
          // the cached access token was refused: the next run refreshes it
          await this.db
            .prepare('UPDATE accounts SET access_iv = NULL, access_ct = NULL, access_expires_at = NULL WHERE id = ?1')
            .bind(a.id)
            .run()
        }
        if (e.step === 'gmail.list' && (e.status === 400 || e.status === 404)) {
          // the label was deleted or renamed: look it up again next run
          await this.db.prepare('UPDATE accounts SET label_id = NULL WHERE id = ?1').bind(a.id).run()
        }
      }
      throw e
    }
  }
}

/** One sync run over every account whose grant is alive. Never throws: errors are logged as codes. */
export async function runSync(env: Env, deps: Deps, mods: SyncModules, max = RUN_MAX_REQUESTS): Promise<SyncReport> {
  const run = new Run(env, deps, mods, max)
  try {
    requireConfig(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TOKEN_KEY'])
    run.key = await tokenKey(env.TOKEN_KEY!)
    const missingKey = missingModelKey(env)
    if (missingKey) slog('missing', { name: missingKey })
    const rows = await env.DB.prepare(
      `SELECT id, email_hash, self_hash, refresh_iv, refresh_ct, access_iv, access_ct, access_expires_at, label_id
       FROM accounts WHERE needs_signin = 0 AND self_hash IS NOT NULL ORDER BY id`,
    ).all<AccountRow>()
    for (const a of rows.results) {
      run.report.accounts += 1
      // the daily cap used up, or no key: nothing is triaged (and no message is fetched for it)
      const canTriage = !missingKey && (await run.dailyLeft()) > 0
      try {
        await run.account(a, canTriage)
      } catch (e) {
        if (e instanceof RunCapReached) throw e
        slog('account_error', {
          account: a.id,
          code: e instanceof GoogleError ? `${e.step} ${e.status}` : e instanceof Error ? e.name : 'error',
        })
      }
    }
  } catch (e) {
    if (e instanceof RunCapReached) {
      run.report.capped = true
      slog('cap', { requests: run.cap.used })
    } else if (e instanceof MissingConfig) slog('missing', { name: e.names.join(',') })
    else slog('error', { code: e instanceof Error ? e.name : 'error' })
  }
  run.report.requests = run.cap.used
  slog('done', { ...run.report })
  return run.report
}
