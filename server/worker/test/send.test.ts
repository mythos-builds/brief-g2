// BRIEF-D4 § 3.2 to 3.4 and § 6.1: the real send from POST /api/items/<id>/send, paired, against a stubbed Gmail
// (made-up tokens, example.com addresses only). Every request is recorded, every log line too.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handle } from '../src/app'
import type { Env } from '../src/env'
import { ALLOWED, clock, type FetchStub, req, testEnv } from './helpers'
import { decodeWords, parseMessage } from './reply.test'
import { alias, pairedSession, TRIAGE_ANSWER } from './sync-fakes'

const db = (env as Env).DB
const T0 = 1_795_000_000
const SCOPE_FULL = 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'
const SUBJ = 'SUBJECTMARK Cover Friday 6 am shift?'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
const GET_RE = /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/([A-Za-z0-9_-]+)\?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References$/

type SendMode = 'ok' | '400' | '500' | 'hang' | '401-once' | 'noid' | '401'

interface Call {
  method: string
  url: string
  body: string
  auth: string
}

/** Google as the send sees it: the token endpoint, messages.get format=metadata, messages.send. */
class SendFake {
  calls: Call[] = []
  mode: SendMode = 'ok'
  getMode: 'ok' | '401-once' | '500' = 'ok'
  dead = false
  headers: Array<{ name: string; value: string }> = [
    { name: 'From', value: `Marco Bellini <${alias('marco')}>` },
    { name: 'Subject', value: SUBJ },
    { name: 'Message-ID', value: '<orig-m1@example.com>' },
    { name: 'References', value: '<r0@example.com> <r1@example.com>' },
  ]
  private n = 0
  private sendTries = 0
  private getTries = 0

  fetch: FetchStub = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    this.calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : '', auth })
    if (method === 'POST' && url === TOKEN_URL) {
      if (this.dead) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      this.n += 1
      return Response.json({ access_token: `fake-access-${this.n}`, expires_in: 3599, token_type: 'Bearer' })
    }
    if (!/^Bearer fake-access-\d+$/.test(auth)) return Response.json({ error: { code: 401 } }, { status: 401 })
    const g = GET_RE.exec(url)
    if (method === 'GET' && g) {
      this.getTries += 1
      if (this.getMode === '401-once' && this.getTries === 1) return Response.json({ error: { code: 401 } }, { status: 401 })
      if (this.getMode === '500') return new Response('upstream', { status: 500 })
      return Response.json({ id: g[1], threadId: `t-${g[1]}`, labelIds: ['Label_42'], payload: { headers: this.headers } })
    }
    if (method === 'POST' && url === SEND_URL) {
      this.sendTries += 1
      const m = this.mode
      if (m === '401' || (m === '401-once' && this.sendTries === 1)) return Response.json({ error: { code: 401 } }, { status: 401 })
      if (m === '400') return Response.json({ error: { code: 400, message: 'Invalid To header' } }, { status: 400 })
      if (m === '500') return new Response('backend error', { status: 500 })
      if (m === 'hang')
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      if (m === 'noid') return Response.json({ labelIds: ['SENT'] })
      const { threadId } = JSON.parse(String(init?.body)) as { threadId: string }
      return Response.json({ id: `sent-${this.sendTries}`, threadId, labelIds: ['SENT'] })
    }
    return Response.json({ error: 'not in decision 1.5' }, { status: 404 })
  }

  get sends(): Call[] {
    return this.calls.filter((c) => c.method === 'POST' && c.url === SEND_URL)
  }
  /** The messages that reached messages.send, decoded. */
  posted(): Array<{ threadId: string; raw: string; m: ReturnType<typeof parseMessage> }> {
    return this.sends.map((c) => {
      const body = JSON.parse(c.body) as { raw: string; threadId: string }
      expect(Object.keys(body).sort()).toEqual(['raw', 'threadId'])
      const b = body.raw.replace(/-/g, '+').replace(/_/g, '/')
      const raw = new TextDecoder().decode(Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (x) => x.charCodeAt(0)))
      return { threadId: body.threadId, raw, m: parseMessage(raw) }
    })
  }
}

async function run(request: Request, e: Env, f: FetchStub): Promise<Response> {
  const ctx = createExecutionContext()
  const res = await handle(request, e, ctx, { fetch: f, now: () => clock.t, sendCallLimitMs: 50 })
  await waitOnExecutionContext(ctx)
  return res
}

const ON = () => testEnv({ REAL_SEND: 'on' })
const send = (token: string, id: string, choice: number, e: Env, f: FetchStub) =>
  run(req(`/api/items/${id}/send`, { method: 'POST', token, body: JSON.stringify({ choice }) }), e, f)
const items = async (token: string, e: Env, f: FetchStub) =>
  ((await (await run(req('/api/items', { token }), e, f)).json()) as { items: Array<{ id: string }> }).items.map((i) => i.id)

async function insertMessage(accountId: number, id: string, persona = 'marco', at = T0 - 600): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO messages (account_id, msg_id, thread_id, persona, received_at, state, tries, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'done', 1, ?5)`,
      )
      .bind(accountId, id, `t-${id}`, persona, at),
    db
      .prepare('INSERT INTO triage_results (id, result, created_at) VALUES (?1, ?2, ?3)')
      .bind(`${accountId}:${id}`, JSON.stringify({ ...TRIAGE_ANSWER, provider: 'fake' }), at),
  ])
}

async function setup(scope = SCOPE_FULL): Promise<{ token: string; accountId: number }> {
  const token = await pairedSession()
  const acct = await db.prepare('SELECT id FROM accounts').first<{ id: number }>()
  await db.prepare('UPDATE accounts SET scope = ?1').bind(scope).run()
  await insertMessage(acct!.id, 'm1')
  return { token, accountId: acct!.id }
}

const row = (id = 'm1') =>
  db
    .prepare('SELECT handled_at, handled_action, handled_choice, send_state, sent_id FROM messages WHERE msg_id = ?1')
    .bind(id)
    .first<{ handled_at: number | null; handled_action: string | null; handled_choice: number | null; send_state: string | null; sent_id: string | null }>()

async function expectError(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status)
  expect(await res.json()).toEqual({ error: code })
}

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  clock.t = T0
  log = vi.spyOn(console, 'log')
})

describe('REAL_SEND not exactly "on" → day-3 behaviour, no Google call at all (§ 3.2 f)', () => {
  for (const v of [undefined, 'off', 'ON', 'true', ' on']) {
    it(`REAL_SEND ${JSON.stringify(v)} → 200 {"sent":true,"real":false}, handled, no call`, async () => {
      const { token } = await setup()
      const up = new SendFake()
      const e = testEnv({ REAL_SEND: v })
      const res = await send(token, 'm1', 0, e, up.fetch)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ sent: true, real: false })
      expect(up.calls).toHaveLength(0)
      expect(await row()).toMatchObject({ handled_action: 'send', handled_choice: 0, send_state: null })
      await expectError(await send(token, 'm1', 0, e, up.fetch), 409, 'already_handled')
    })
  }
  it('wrangler.toml ships REAL_SEND "off" and SEND_DAILY_CAP "20"', () => {
    expect((env as Env).REAL_SEND).toBe('off')
    expect((env as Env).SEND_DAILY_CAP).toBe('20')
  })
})

describe('REAL_SEND "on": the three calls and the message that leaves (§ 3.3)', () => {
  it('token → messages.get metadata → messages.send, in order; one To = the alias, From = the account, the draft', async () => {
    const { token } = await setup()
    const up = new SendFake()
    const res = await send(token, 'm1', 0, ON(), up.fetch)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sent: true, real: true })
    expect(up.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      `POST ${TOKEN_URL}`,
      'GET https://gmail.googleapis.com/gmail/v1/users/me/messages/m1',
      `POST ${SEND_URL}`,
    ])
    expect(up.calls[1]!.url).toMatch(GET_RE)
    const [p] = up.posted()
    expect(p!.threadId).toBe('t-m1')
    const h = Object.fromEntries(p!.m.headers)
    expect(p!.m.headers.filter(([n]) => n === 'To')).toEqual([['To', alias('marco')]])
    expect(h.From).toBe(ALLOWED)
    expect(h.Subject).toBe(`Re: ${SUBJ}`)
    expect(h['In-Reply-To']).toBe('<orig-m1@example.com>')
    expect(h.References).toBe('<r0@example.com> <r1@example.com> <orig-m1@example.com>')
    expect(p!.m.body).toBe(`${TRIAGE_ANSWER.draft}\r\n\r\n-- \r\nSent from my glasses with Brief`)
    expect(await row()).toMatchObject({ handled_action: 'send', handled_choice: 0, send_state: 'sent', sent_id: 'sent-1' })
    // the item has left the list; a second press → 409, still ONE send
    expect(await items(token, ON(), up.fetch)).toEqual([])
    await expectError(await send(token, 'm1', 0, ON(), up.fetch), 409, 'already_handled')
    expect(up.sends).toHaveLength(1)
  })

  it('choice 3 sends alts[2] exactly; the cached access token (more than 60 s left) is used: no second refresh', async () => {
    const { token, accountId } = await setup()
    await insertMessage(accountId, 'm2', 'priya', T0 - 300)
    const up = new SendFake()
    expect((await send(token, 'm1', 0, ON(), up.fetch)).status).toBe(200)
    up.headers[0] = { name: 'From', value: alias('priya') }
    expect((await send(token, 'm2', 3, ON(), up.fetch)).status).toBe(200)
    expect(up.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1)
    const p = up.posted()[1]!
    expect(p.m.body).toBe(`${TRIAGE_ANSWER.alts[2]}\r\n\r\n-- \r\nSent from my glasses with Brief`)
    expect(Object.fromEntries(p.m.headers).To).toBe(alias('priya'))
    expect(p.threadId).toBe('t-m2')
    expect(await row('m2')).toMatchObject({ handled_choice: 3, send_state: 'sent' })
    // 60 s or less left → one refresh
    clock.t += 3599 - 60
    await insertMessage(accountId, 'm3', 'marco', T0)
    up.headers[0] = { name: 'From', value: alias('marco') }
    expect((await send(token, 'm3', 1, ON(), up.fetch)).status).toBe(200)
    expect(up.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2)
  })

  it('a subject holding \\r\\nBcc: x@evil.example → no Bcc header; a non-ASCII subject; RE: kept as is', async () => {
    const { token, accountId } = await setup()
    await insertMessage(accountId, 'm2', 'marco')
    await insertMessage(accountId, 'm3', 'marco')
    const up = new SendFake()
    up.headers[1] = { name: 'Subject', value: 'Hi\r\nBcc: x@evil.example' }
    expect((await send(token, 'm1', 0, ON(), up.fetch)).status).toBe(200)
    up.headers[1] = { name: 'Subject', value: 'Café à 6 h ?' }
    expect((await send(token, 'm2', 0, ON(), up.fetch)).status).toBe(200)
    up.headers[1] = { name: 'Subject', value: 'RE: Line 2 tripped' }
    expect((await send(token, 'm3', 0, ON(), up.fetch)).status).toBe(200)
    const [a, b, c] = up.posted()
    expect(a!.m.headers.map(([n]) => n)).not.toContain('Bcc')
    expect(a!.raw).not.toMatch(/^Bcc:/im)
    expect(Object.fromEntries(a!.m.headers).Subject).toBe('Re: HiBcc: x@evil.example')
    expect(decodeWords(Object.fromEntries(b!.m.headers).Subject!)).toBe('Re: Café à 6 h ?')
    expect(Object.fromEntries(c!.m.headers).Subject).toBe('RE: Line 2 tripped')
  })

  it('a bad Message-ID → sent without In-Reply-To and References', async () => {
    const { token } = await setup()
    const up = new SendFake()
    up.headers[2] = { name: 'Message-ID', value: 'not-an-id@example.com' }
    expect((await send(token, 'm1', 0, ON(), up.fetch)).status).toBe(200)
    const names = up.posted()[0]!.m.headers.map(([n]) => n)
    expect(names).toEqual(['From', 'To', 'Subject', 'Date', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding'])
  })
})

describe('definite failures → 502 send_failed, nothing sent, the claim released (§ 3.4)', () => {
  const senders: Array<[string, Array<{ name: string; value: string }>]> = [
    ['another persona', [{ name: 'From', value: alias('priya') }]],
    ['a stranger', [{ name: 'From', value: 'Someone <someone@example.org>' }]],
    ['two From', [{ name: 'From', value: alias('marco') }, { name: 'From', value: alias('marco') }]],
    ['the bare account (no tag)', [{ name: 'From', value: ALLOWED }]],
    ['an alias of another account', [{ name: 'From', value: alias('marco', 'other@example.com') }]],
    ['no From', []],
  ]
  for (const [name, from] of senders) {
    it(`Gmail's copy now shows ${name} → 502, nothing sent, the item is back in the list`, async () => {
      const { token } = await setup()
      const up = new SendFake()
      up.headers = [...from, { name: 'Subject', value: SUBJ }, { name: 'Message-ID', value: '<orig-m1@example.com>' }]
      await expectError(await send(token, 'm1', 0, ON(), up.fetch), 502, 'send_failed')
      expect(up.sends).toHaveLength(0)
      expect(await row()).toEqual({ handled_at: null, handled_action: null, handled_choice: null, send_state: null, sent_id: null })
      expect(await items(token, ON(), up.fetch)).toEqual(['m1'])
    })
  }

  it('call 3 answers 400 → 502, offered again; a second press sends ONCE; the day count is not given back', async () => {
    const { token, accountId } = await setup()
    const up = new SendFake()
    up.mode = '400'
    await expectError(await send(token, 'm1', 2, ON(), up.fetch), 502, 'send_failed')
    expect(await row()).toMatchObject({ handled_at: null, send_state: null })
    expect(await items(token, ON(), up.fetch)).toEqual(['m1'])
    up.mode = 'ok'
    expect((await send(token, 'm1', 2, ON(), up.fetch)).status).toBe(200)
    expect(up.sends).toHaveLength(2) // the refused one and the one that left
    expect(up.posted()[1]!.m.body.startsWith(TRIAGE_ANSWER.alts[1]!)).toBe(true)
    const day = new Date(T0 * 1000).toISOString().slice(0, 10)
    expect((await db.prepare('SELECT count FROM counters WHERE key = ?1').bind(`send:${accountId}:${day}`).first<{ count: number }>())!.count).toBe(2)
  })

  it('messages.get fails (500) → 502 and no send; a second 401 (after the one refresh) → 502', async () => {
    const { token } = await setup()
    const up = new SendFake()
    up.getMode = '500'
    await expectError(await send(token, 'm1', 0, ON(), up.fetch), 502, 'send_failed')
    expect(up.sends).toHaveLength(0)
    up.getMode = 'ok'
    up.mode = '401'
    await expectError(await send(token, 'm1', 0, ON(), up.fetch), 502, 'send_failed')
    expect(up.sends).toHaveLength(2) // one 401, one retry after one refresh, both refused
    expect(await row()).toMatchObject({ handled_at: null, send_state: null })
  })
})

describe('unknown outcomes → 504 send_unknown: handled for good, never retried, never offered again (§ 3.4)', () => {
  for (const mode of ['500', 'hang', 'noid'] as const) {
    it(`call 3: ${mode} → 504, the row stays handled, a second press → 409, ONE messages.send`, async () => {
      const { token } = await setup()
      const up = new SendFake()
      up.mode = mode
      await expectError(await send(token, 'm1', 1, ON(), up.fetch), 504, 'send_unknown')
      expect(await row()).toMatchObject({ handled_action: 'send', handled_choice: 1, send_state: 'unknown', sent_id: null })
      expect(await items(token, ON(), up.fetch)).toEqual([])
      up.mode = 'ok'
      await expectError(await send(token, 'm1', 1, ON(), up.fetch), 409, 'already_handled')
      expect(up.sends).toHaveLength(1)
    })
  }

  it('a row left « sending » by a crash is treated as unknown: not listed, a press → 409, no Google call', async () => {
    const { token } = await setup()
    await db.prepare("UPDATE messages SET handled_at = ?1, handled_action = 'send', handled_choice = 0, send_state = 'sending'").bind(T0).run()
    const up = new SendFake()
    expect(await items(token, ON(), up.fetch)).toEqual([])
    await expectError(await send(token, 'm1', 0, ON(), up.fetch), 409, 'already_handled')
    await expectError(await run(req('/api/items/m1/skip', { method: 'POST', token }), ON(), up.fetch), 409, 'already_handled')
    expect(up.calls).toHaveLength(0)
  })
})

describe('tokens, the grant, the scope, the cap, the race (§ 3.2 b, g, h; § 3.3 1)', () => {
  it('401 once on call 3 → one refresh, one retry, sent', async () => {
    const { token } = await setup()
    const up = new SendFake()
    up.mode = '401-once'
    expect((await send(token, 'm1', 0, ON(), up.fetch)).status).toBe(200)
    expect(up.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`)).toEqual([
      `POST ${TOKEN_URL}`,
      'GET https://gmail.googleapis.com/gmail/v1/users/me/messages/m1',
      `POST ${SEND_URL}`,
      `POST ${TOKEN_URL}`,
      `POST ${SEND_URL}`,
    ])
    expect(up.sends[1]!.auth).toBe('Bearer fake-access-2')
    expect(await row()).toMatchObject({ send_state: 'sent', sent_id: 'sent-2' })
  })

  it('401 once on call 2 → one refresh, one retry, sent', async () => {
    const { token } = await setup()
    const up = new SendFake()
    up.getMode = '401-once'
    expect((await send(token, 'm1', 0, ON(), up.fetch)).status).toBe(200)
    expect(up.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2)
    expect(up.sends).toHaveLength(1)
  })

  it('invalid_grant → 403 signin_needed, needs_signin set, the claim released, nothing sent', async () => {
    const { token, accountId } = await setup()
    const up = new SendFake()
    up.dead = true
    await expectError(await send(token, 'm1', 0, ON(), up.fetch), 403, 'signin_needed')
    expect(up.sends).toHaveLength(0)
    const a = await db.prepare('SELECT needs_signin, access_ct FROM accounts WHERE id = ?1').bind(accountId).first()
    expect(a).toEqual({ needs_signin: 1, access_ct: null })
    expect(await row()).toMatchObject({ handled_at: null, send_state: null })
    // and from now on every paired route says so, the send first
    await expectError(await send(token, 'm1', 0, ON(), up.fetch), 403, 'signin_needed')
  })

  it('two requests at the same moment → one 200, one 409, ONE messages.send', async () => {
    const { token } = await setup()
    const up = new SendFake()
    const [a, b] = await Promise.all([send(token, 'm1', 0, ON(), up.fetch), send(token, 'm1', 4, ON(), up.fetch)])
    expect([a!.status, b!.status].sort()).toEqual([200, 409])
    expect(up.sends).toHaveLength(1)
  })

  it('the stored scope without gmail.send → 403 signin_needed, nothing claimed, no call; with REAL_SEND off the old path', async () => {
    const { token } = await setup('openid email https://www.googleapis.com/auth/gmail.readonly')
    const up = new SendFake()
    await expectError(await send(token, 'm1', 0, ON(), up.fetch), 403, 'signin_needed')
    expect(up.calls).toHaveLength(0)
    expect(await row()).toMatchObject({ handled_at: null })
    expect((await send(token, 'm1', 0, testEnv({ REAL_SEND: 'off' }), up.fetch)).status).toBe(200)
  })

  it('the daily cap reached → 429 daily_cap, nothing claimed, no call', async () => {
    const { token, accountId } = await setup()
    const day = new Date(T0 * 1000).toISOString().slice(0, 10)
    await db.prepare('INSERT INTO counters (key, count, window_end) VALUES (?1, 20, ?2)').bind(`send:${accountId}:${day}`, T0 + 86_400).run()
    const up = new SendFake()
    await expectError(await send(token, 'm1', 0, ON(), up.fetch), 429, 'daily_cap')
    expect(up.calls).toHaveLength(0)
    expect(await row()).toMatchObject({ handled_at: null, send_state: null })
    // SEND_DAILY_CAP is read: 21 → the press goes through; the next UTC day starts again
    expect((await send(token, 'm1', 0, testEnv({ REAL_SEND: 'on', SEND_DAILY_CAP: '21' }), up.fetch)).status).toBe(200)
  })

  it('an account outside today\'s ALLOWED_ACCOUNTS → 401 on send and skip, nothing claimed, nothing deleted', async () => {
    const { token } = await setup()
    const up = new SendFake()
    const e = testEnv({ REAL_SEND: 'on', ALLOWED_ACCOUNTS: 'second@example.net' })
    await expectError(await send(token, 'm1', 0, e, up.fetch), 401, 'unauthorized')
    await expectError(await run(req('/api/items/m1/skip', { method: 'POST', token }), e, up.fetch), 401, 'unauthorized')
    expect(up.calls).toHaveLength(0)
    expect(await row()).toMatchObject({ handled_at: null })
    expect((await db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())!.n).toBe(1)
  })
})

describe('what leaves the Worker (§ 1.5, § 3.4 logs)', () => {
  it('no answer and no log line ever holds an address, an alias, a subject, a body or a token; only the calls of 1.5', async () => {
    const { token, accountId } = await setup()
    for (const id of ['m2', 'm3', 'm4', 'm5']) await insertMessage(accountId, id)
    const up = new SendFake()
    const answers: string[] = []
    const press = async (id: string, mode: SendMode) => {
      up.mode = mode
      answers.push(await (await send(token, id, 1, ON(), up.fetch)).text())
    }
    await press('m1', 'ok')
    await press('m2', '400')
    await press('m3', '500')
    await press('m4', 'hang')
    await press('m5', '401-once')
    expect(answers.map((a) => JSON.parse(a))).toEqual([
      { sent: true, real: true },
      { error: 'send_failed' },
      { error: 'send_unknown' },
      { error: 'send_unknown' },
      { sent: true, real: true },
    ])
    // the list keeps its day-3 shape: the persona's fictional address, never the account or its alias
    const list = await (await run(req('/api/items', { token }), ON(), up.fetch)).text()
    for (const secret of [ALLOWED, 'allowed.demo', '+marco', 'SUBJECTMARK', 'orig-m1']) expect(list).not.toContain(secret)
    const logged = log.mock.calls.map((c: unknown[]) => c.map(String).join(' ')).join('\n')
    expect(logged).toContain('"route":"api.items.send"')
    for (const secret of [ALLOWED, 'allowed.demo', '+marco', 'example.com', 'SUBJECTMARK', TRIAGE_ANSWER.alts[0]!, 'Sent from my', 'fake-access', 'orig-m1']) {
      expect(logged).not.toContain(secret)
    }
    for (const c of up.calls) {
      const ok =
        (c.method === 'POST' && c.url === TOKEN_URL) || (c.method === 'GET' && GET_RE.test(c.url)) || (c.method === 'POST' && c.url === SEND_URL)
      expect(ok, `${c.method} ${c.url}`).toBe(true)
    }
    // stored: the state, Gmail's id, the times and the choice; never the text or an address
    const dump = JSON.stringify((await db.prepare('SELECT * FROM messages').all()).results)
    for (const secret of [ALLOWED, '+marco', 'SUBJECTMARK', TRIAGE_ANSWER.alts[0]!]) expect(dump).not.toContain(secret)
  })

  it('6 Google calls at most per request', async () => {
    const { token } = await setup()
    const up = new SendFake()
    up.getMode = '401-once'
    up.mode = '401'
    await expectError(await send(token, 'm1', 0, ON(), up.fetch), 502, 'send_failed')
    expect(up.calls.length).toBeLessThanOrEqual(6)
  })
})
