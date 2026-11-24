// BRIEF-D5 § 3.6 and § 6.2: the send's sixth choice, {"choice":5,"rev":"<8 hex>"} = the stored spoken draft. The
// day-4 send tests (test/send.test.ts) run unchanged next to these. Google is a stub (made-up tokens, example.com).
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import { SIGNATURE } from '../src/send'
import { clock, demoSession, type FetchStub, testEnv } from './helpers'
import { db, expectError, FakeAi, insertMessage, REPLY, REPLY_2, run, sha8, speakReq, tone, TWO_S } from './d5-helpers'
import { alias, pairedSession } from './sync-fakes'

const T0 = 1_795_000_000
const SCOPE_FULL = 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
const GET_RE = /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/([A-Za-z0-9_-]+)\?format=metadata&/

/** Google as one send sees it: the token endpoint, messages.get (metadata), messages.send. Records every call. */
class Gmail {
  calls: Array<{ method: string; url: string; body: string }> = []
  fetch: FetchStub = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    this.calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : '' })
    if (method === 'POST' && url === TOKEN_URL) return Response.json({ access_token: 'fake-access-2', expires_in: 3599, token_type: 'Bearer' })
    const g = GET_RE.exec(url)
    if (method === 'GET' && g)
      return Response.json({
        id: g[1],
        threadId: `t-${g[1]}`,
        labelIds: ['Label_42'],
        payload: {
          headers: [
            { name: 'From', value: `Marco Bellini <${alias('marco')}>` },
            { name: 'Subject', value: 'Cover Friday 6 am shift?' },
            { name: 'Message-ID', value: '<orig-m1@example.com>' },
          ],
        },
      })
    if (method === 'POST' && url === SEND_URL) return Response.json({ id: 'sent-1', threadId: 't-m1', labelIds: ['SENT'] })
    return Response.json({ error: 'unexpected' }, { status: 404 })
  }
  get sends() {
    return this.calls.filter((c) => c.method === 'POST' && c.url === SEND_URL)
  }
  /** The text of each message that reached messages.send, decoded (base64url → MIME → base64 body → UTF-8). */
  bodies(): string[] {
    return this.sends.map((c) => {
      const b = (JSON.parse(c.body) as { raw: string }).raw.replace(/-/g, '+').replace(/_/g, '/')
      const raw = new TextDecoder().decode(Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (x) => x.charCodeAt(0)))
      const part = raw.slice(raw.indexOf('\r\n\r\n') + 4).replace(/\r\n/g, '')
      return new TextDecoder().decode(Uint8Array.from(atob(part), (x) => x.charCodeAt(0)))
    })
  }
}

const sendReq = (id: string, token: string, body: unknown) =>
  new Request(`https://brief.appfinishers.com/api/items/${id}/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const row = () =>
  db
    .prepare("SELECT handled_at, handled_action, handled_choice, send_state, sent_id FROM messages WHERE msg_id = 'm1'")
    .first<{ handled_at: number | null; handled_action: string | null; handled_choice: number | null; send_state: string | null; sent_id: string | null }>()

async function paired(): Promise<string> {
  const token = await pairedSession()
  const acct = await db.prepare('SELECT id FROM accounts').first<{ id: number }>()
  await db.prepare('UPDATE accounts SET scope = ?1').bind(SCOPE_FULL).run()
  await insertMessage(acct!.id, 'm1')
  return token
}

async function speak(id: string, token: string, e: Env = testEnv(), ai = new FakeAi()): Promise<{ draft: string; rev: string }> {
  const res = await run(speakReq(id, token, tone(TWO_S)), { ai, env: e })
  expect(res.status).toBe(200)
  return (await res.json()) as { draft: string; rev: string }
}

beforeEach(() => {
  clock.t = T0
})

describe('choice 5 sends the stored spoken draft (§ 3.6)', () => {
  it('demo: 200 {"sent":true,"real":false}, handled with choice 5, nothing leaves', async () => {
    const token = await demoSession()
    const { rev } = await speak('mail-0', token)
    const g = new Gmail()
    const res = await run(sendReq('mail-0', token, { choice: 5, rev }), { fetch: g.fetch })
    expect(await res.json()).toEqual({ sent: true, real: false })
    expect(g.calls).toEqual([])
    expect(await db.prepare("SELECT action, choice FROM handled WHERE item_id = 'mail-0'").first()).toEqual({ action: 'send', choice: 5 })
    // a speak after the send: the item is handled
    await expectError(await run(speakReq('mail-0', token, tone(TWO_S)), { ai: new FakeAi() }), 409, 'already_handled')
  })

  it('paired, REAL_SEND off: 200 real:false, handled_choice 5, no Google call at all', async () => {
    const token = await paired()
    const { rev } = await speak('m1', token)
    const g = new Gmail()
    const res = await run(sendReq('m1', token, { choice: 5, rev }), { fetch: g.fetch })
    expect(await res.json()).toEqual({ sent: true, real: false })
    expect(g.calls).toEqual([])
    expect(await row()).toMatchObject({ handled_action: 'send', handled_choice: 5, send_state: null })
  })

  it('paired, REAL_SEND on: the mail that leaves = exactly the spoken draft, then the signature', async () => {
    const token = await paired()
    const on = testEnv({ REAL_SEND: 'on' })
    const { draft, rev } = await speak('m1', token, on)
    expect(draft).toBe(REPLY)
    const g = new Gmail()
    const res = await run(sendReq('m1', token, { choice: 5, rev }), { env: on, fetch: g.fetch })
    expect(await res.json()).toEqual({ sent: true, real: true })
    expect(g.sends).toHaveLength(1)
    expect(g.bodies()).toEqual([`${REPLY}\r\n\r\n-- \r\n${SIGNATURE}`])
    expect(await row()).toEqual({ handled_at: T0, handled_action: 'send', handled_choice: 5, send_state: 'sent', sent_id: 'sent-1' })
  })

  it('choices 0 to 4 still send their own text after a spoken draft exists', async () => {
    const token = await paired()
    const on = testEnv({ REAL_SEND: 'on' })
    await speak('m1', token, on)
    const g = new Gmail()
    expect((await run(sendReq('m1', token, { choice: 2 }), { env: on, fetch: g.fetch })).status).toBe(200)
    expect(g.bodies()).toEqual([`No, I cannot make it.\r\n\r\n-- \r\n${SIGNATURE}`])
  })
})

describe('409 stale_draft: nothing claimed, no Google call (§ 3.6)', () => {
  it('paired, REAL_SEND on: a wrong rev · no stored draft · a second clip between the look and the press', async () => {
    const token = await paired()
    const on = testEnv({ REAL_SEND: 'on' })
    const g = new Gmail()
    await expectError(await run(sendReq('m1', token, { choice: 5, rev: '0badc0de' }), { env: on, fetch: g.fetch }), 409, 'stale_draft')
    const ai = new FakeAi()
    ai.llm = 'second'
    const first = await speak('m1', token, on, ai)
    await expectError(await run(sendReq('m1', token, { choice: 5, rev: '0badc0de' }), { env: on, fetch: g.fetch }), 409, 'stale_draft')
    const second = await speak('m1', token, on, ai)
    expect(second.draft).toBe(REPLY_2)
    await expectError(await run(sendReq('m1', token, { choice: 5, rev: first.rev }), { env: on, fetch: g.fetch }), 409, 'stale_draft')
    expect(g.calls).toEqual([])
    expect(await row()).toEqual({ handled_at: null, handled_action: null, handled_choice: null, send_state: null, sent_id: null })
    // the one on screen goes
    expect((await run(sendReq('m1', token, { choice: 5, rev: second.rev }), { env: on, fetch: g.fetch })).status).toBe(200)
    expect(g.bodies()).toEqual([`${REPLY_2}\r\n\r\n-- \r\n${SIGNATURE}`])
  })

  it('a stored draft that no longer passes checkSpoken (a link, too long, quoted, no stop) → 409, even with its own rev', async () => {
    const token = await paired()
    const on = testEnv({ REAL_SEND: 'on' })
    const g = new Gmail()
    for (const bad of ['See https://example.com/a now.', `${'a'.repeat(110)}.`, '"Thursday at two works."', 'Thursday at two works', 'One.\nTwo.\nThree.']) {
      await db.prepare("UPDATE messages SET spoken_draft = ?1 WHERE msg_id = 'm1'").bind(bad).run()
      await expectError(await run(sendReq('m1', token, { choice: 5, rev: await sha8(bad) }), { env: on, fetch: g.fetch }), 409, 'stale_draft')
    }
    expect(g.calls).toEqual([])
    expect((await row())?.handled_at).toBeNull()
  })

  it('demo: another session\'s spoken draft is not this session\'s (its rev → 409), nothing handled', async () => {
    const a = await demoSession()
    const b = await demoSession()
    const { rev } = await speak('mail-0', a)
    await expectError(await run(sendReq('mail-0', b, { choice: 5, rev })), 409, 'stale_draft')
    await expectError(await run(sendReq('mail-0', a, { choice: 5, rev: '0badc0de' })), 409, 'stale_draft')
    expect((await db.prepare('SELECT COUNT(*) AS n FROM handled').first<{ n: number }>())?.n).toBe(0)
  })
})

describe('the body (§ 3.6): any other shape → 400, before the spoken draft is looked at', () => {
  it('rev with a choice 0 to 4, choice 5 without rev, a rev of another shape, another key → 400', async () => {
    const token = await paired()
    const on = testEnv({ REAL_SEND: 'on' })
    const { rev } = await speak('m1', token, on)
    const g = new Gmail()
    const bodies: unknown[] = [
      { choice: 2, rev },
      { choice: 0, rev },
      { choice: 5 },
      { choice: 5, rev: rev.toUpperCase() === rev ? 'ABCDEF12' : rev.toUpperCase() },
      { choice: 5, rev: rev.slice(0, 7) },
      { choice: 5, rev: `${rev}0` },
      { choice: 5, rev: Number.parseInt(rev, 16) },
      { choice: 5, rev, text: REPLY },
      { choice: '5', rev },
      { choice: 6, rev },
      { rev },
    ]
    for (const b of bodies) await expectError(await run(sendReq('m1', token, b), { env: on, fetch: g.fetch }), 400, 'bad_request')
    expect(g.calls).toEqual([])
    expect((await row())?.handled_at).toBeNull()
  })
})
