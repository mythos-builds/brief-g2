// A stubbed Google + model for the sync tests (made-up tokens, example.com addresses only), and fakes of job B's two
// modules with the BRIEF-D3 § 3.6 signatures. Every request is recorded so a test can assert what the Worker called.
import { env } from 'cloudflare:workers'
import type { BriefInput, BriefResult } from '../../triage/brief'
import type { SeenMail } from '../../triage/gmail'
import type { TriageOptions } from '../../triage/types'
import { open as openSealed, seal, sha256hex, tokenKey } from '../src/crypto'
import type { Deps, Env } from '../src/env'
import type { Persona } from '../src/personas'
import type { SyncModules } from '../src/sync'
import { runSync } from '../src/sync'
import { ALLOWED, call, clock, codeOf, FAKE_REFRESH, googleStub, req, startState, testEnv } from './helpers'

export const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions'
export const LABEL_ID = 'Label_42'
export const BODY_MARK = 'BODYTEXT-never-served'
export const SUBJECT_MARK = 'SUBJECTTEXT-never-served'

export interface FakeMail {
  id: string
  from: string
  /** Unix seconds */
  at: number
}

export interface FakeEvent {
  id: string
  summary: string
  start: number
  attendees?: string[]
  creatorSelf?: boolean
  organizerSelf?: boolean
  allDay?: boolean
  /** Google's eventType ("default", "fromGmail"…); absent = not sent */
  eventType?: string
}

export interface Recorded {
  method: string
  url: string
  body: string
}

/** The account's plus-alias for a tag: allowed.demo+marco@example.com. */
export function alias(tag: string, account = ALLOWED): string {
  const [user, domain] = account.split('@') as [string, string]
  return `${user}+${tag}@${domain}`
}

export const TRIAGE_ANSWER = {
  needs_reply: true,
  summary: 'can you cover Friday',
  draft: 'Yes, I can cover Friday on line 1.',
  alts: ['Yes, I will be there.', 'No, I cannot make it.', 'I will confirm later today.', 'What time do you need me?'],
}

export class FakeUpstream {
  calls: Recorded[] = []
  mails: FakeMail[] = []
  events: FakeEvent[] = []
  labels = [
    { id: 'INBOX', name: 'INBOX' },
    { id: LABEL_ID, name: 'brief-demo' },
  ]
  /** The label id whose messages messages.list returns (any other id → 400). */
  listLabel = LABEL_ID
  /** The refresh token Google treats as revoked (400 invalid_grant). */
  deadRefresh = new Set<string>()
  modelAnswer: unknown = TRIAGE_ANSWER
  /** true = messages.get answers in Gmail's own format=full shape (for the real fromGmail of job B). */
  gmailFormat = false
  modelStatus = 200
  private n = 0

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? init.body : ''
    this.calls.push({ method, url: input, body })
    const u = new URL(input)
    const path = `${u.origin}${u.pathname}`
    if (method === 'POST' && path === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(body)
      if (p.get('grant_type') !== 'refresh_token') return Response.json({ error: 'unsupported_grant_type' }, { status: 400 })
      if (this.deadRefresh.has(p.get('refresh_token') ?? '')) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      this.n += 1
      return Response.json({ access_token: `fake-access-${this.n}`, expires_in: 3599, token_type: 'Bearer' })
    }
    if (method === 'POST' && path === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 })
    if (method === 'POST' && path === OPENROUTER) {
      return Response.json(
        { choices: [{ message: { content: JSON.stringify(this.modelAnswer) } }] },
        { status: this.modelStatus },
      )
    }
    if (method !== 'GET') return new Response('no', { status: 405 })
    if (!/^Bearer fake-access-\d+$/.test(new Headers(init?.headers).get('authorization') ?? ''))
      return Response.json({ error: { code: 401 } }, { status: 401 })
    if (path === 'https://gmail.googleapis.com/gmail/v1/users/me/labels') return Response.json({ labels: this.labels })
    if (path === 'https://gmail.googleapis.com/gmail/v1/users/me/messages') {
      if (u.searchParams.get('labelIds') !== this.listLabel) return Response.json({ error: 'wrong label' }, { status: 400 })
      const list = [...this.mails].sort((a, b) => b.at - a.at).slice(0, Number(u.searchParams.get('maxResults') ?? 100))
      return Response.json({ messages: list.map((m) => ({ id: m.id, threadId: `t-${m.id}` })), resultSizeEstimate: list.length })
    }
    const mm = /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path)
    if (mm) {
      const m = this.mails.find((x) => x.id === decodeURIComponent(mm[1]!))
      if (!m) return Response.json({ error: 'not found' }, { status: 404 })
      if (this.gmailFormat) {
        const data = btoa(`Hello, ${BODY_MARK}. Can you call me back today?`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        return Response.json({
          id: m.id,
          threadId: `t-${m.id}`,
          labelIds: [LABEL_ID],
          internalDate: String(m.at * 1000),
          payload: {
            partId: '',
            mimeType: 'text/plain',
            filename: '',
            headers: [
              { name: 'From', value: m.from },
              { name: 'To', value: ALLOWED },
              { name: 'Subject', value: SUBJECT_MARK },
            ],
            body: { size: 60, data },
          },
        })
      }
      return Response.json({
        id: m.id,
        threadId: `t-${m.id}`,
        internalDate: String(m.at * 1000),
        payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: SUBJECT_MARK }] },
        body: BODY_MARK,
      })
    }
    if (path === 'https://www.googleapis.com/calendar/v3/calendars/primary/events') {
      return Response.json({
        items: this.events.map((e) => ({
          id: e.id,
          status: 'confirmed',
          summary: e.summary,
          start: e.allDay ? { date: '2026-11-18' } : { dateTime: new Date(e.start * 1000).toISOString() },
          creator: { email: 'x@example.com', self: e.creatorSelf ?? true },
          organizer: { email: 'x@example.com', self: e.organizerSelf ?? e.creatorSelf ?? true },
          attendees: (e.attendees ?? []).map((a) => ({ email: a })),
          ...(e.eventType ? { eventType: e.eventType } : {}),
        })),
      })
    }
    return Response.json({ error: 'unknown path' }, { status: 404 })
  }

  count(pred: (c: Recorded) => boolean): number {
    return this.calls.filter(pred).length
  }
  get modelCalls(): number {
    return this.count((c) => c.url === OPENROUTER)
  }
  get gets(): number {
    return this.count((c) => /\/messages\/[^/?]+\?/.test(c.url))
  }
}

/** A stand-in for job B's fromGmail: the § 3.6 rule on the fake message shape above. */
export const fakeModules = (opts: { briefAnswer?: unknown } = {}): SyncModules & { briefCalls: BriefInput[] } => {
  const briefCalls: BriefInput[] = []
  return {
    briefCalls,
    async fromGmail(msg: unknown, selfHash: string, personas: Persona[]): Promise<SeenMail | null> {
      const m = msg as { id?: string; threadId?: string; internalDate?: string; payload?: { headers?: Array<{ name: string; value: string }> }; body?: string }
      const froms = (m.payload?.headers ?? []).filter((h) => h.name.toLowerCase() === 'from')
      if (froms.length !== 1 || !m.id) return null
      const addr = (/<([^>]+)>\s*$/.exec(froms[0]!.value)?.[1] ?? froms[0]!.value).trim().toLowerCase()
      const am = /^([^+@\s]+)\+([^+@\s]+)@(\S+)$/.exec(addr)
      if (!am) return null
      if ((await sha256hex(`${am[1]}@${am[3]}`)) !== selfHash) return null
      const persona = personas.find((p) => p.key === am[2])
      if (!persona) return null
      return {
        id: m.id,
        threadId: m.threadId ?? m.id,
        persona,
        receivedAt: Math.floor(Number(m.internalDate) / 1000),
        item: { kind: 'mail', from: persona.key, fromName: persona.fullName, at: '10:00', subject: SUBJECT_MARK, body: m.body ?? '' },
      }
    },
    async meetingBrief(input: BriefInput, o?: TriageOptions): Promise<BriefResult> {
      briefCalls.push(input)
      if (o?.budget && !(await o.budget.take())) throw Object.assign(new Error('budget_exhausted'), { code: 'budget_exhausted' })
      await o?.fetch?.(OPENROUTER, { method: 'POST', headers: {}, body: '{}', signal: new AbortController().signal })
      return (opts.briefAnswer ?? {
        why: 'carton order late',
        last: 'she promised Friday',
        facts: ['corrugator down since Monday', 'new ship date Thursday'],
        provider: 'fake',
      }) as BriefResult
    },
    validBrief(v: unknown): BriefResult | null {
      const b = v as BriefResult
      if (!b || typeof b.why !== 'string' || b.why.length > 60 || b.why.includes('@')) return null
      return b
    },
  }
}

export function syncEnv(overrides: Partial<Env> = {}): Env {
  return testEnv({ OPENROUTER_API_KEY: 'test-model-key-not-real', ...overrides })
}

export function depsOf(up: FakeUpstream): Deps {
  return { fetch: up.fetch, now: () => clock.t }
}

export function sync(up: FakeUpstream, mods: SyncModules, e: Env = syncEnv(), max?: number) {
  return runSync(e, depsOf(up), mods, max)
}

/** Google sign-in for ALLOWED → code → claim: a paired session token (the real day-2 path, with a stubbed Google). */
export async function pairedSession(ip = '203.0.113.50'): Promise<string> {
  const page = await (await call(req(`/oauth/callback?state=${await startState()}&code=c`), { fetch: googleStub(ALLOWED).fetch })).text()
  const res = await call(req('/api/pair/claim', { method: 'POST', body: JSON.stringify({ code: codeOf(page) }), ip }))
  if (res.status !== 200) throw new Error(`claim ${res.status}`)
  return ((await res.json()) as { session: string }).session
}

/** Another account inserted directly (as a sign-in would leave it): its refresh token sealed with TOKEN_KEY. */
export async function insertAccount(email: string, refresh = FAKE_REFRESH): Promise<number> {
  const emailHash = await sha256hex(`email:${email}`)
  const sealed = await seal(await tokenKey((env as Env).TOKEN_KEY!), refresh, emailHash)
  const row = await (env as Env).DB.prepare(
    `INSERT INTO accounts (email_hash, refresh_iv, refresh_ct, scope, created_at, updated_at, self_hash)
     VALUES (?1, ?2, ?3, '', ?4, ?4, ?5) RETURNING id`,
  )
    .bind(emailHash, sealed.iv, sealed.ct, clock.t, await sha256hex(email))
    .first<{ id: number }>()
  return row!.id
}

/** The clear access token cached for an account (to prove it is stored sealed, never in clear). */
export async function cachedAccess(accountId: number, email = ALLOWED): Promise<string | null> {
  const row = await (env as Env).DB.prepare('SELECT access_iv, access_ct FROM accounts WHERE id = ?1')
    .bind(accountId)
    .first<{ access_iv: string | null; access_ct: string | null }>()
  if (!row?.access_iv || !row.access_ct) return null
  return openSealed(await tokenKey((env as Env).TOKEN_KEY!), { iv: row.access_iv, ct: row.access_ct }, `access:${await sha256hex(`email:${email}`)}`)
}
