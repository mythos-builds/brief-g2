// BRIEF-D5 § 3.2, 3.3, 3.5 and § 6.1: POST /api/items/<id>/speak, demo and paired, against a scripted Workers AI.
// No test reaches the live service: the `ai` of every request is injected (FakeAi), env.AI is never called.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SPOKEN_MODEL } from '../../triage/spoken'
import type { Env } from '../src/env'
import { base64Loop, base64Of, heardOf, MODEL_STT, wavOf } from '../src/voice'
import { ALLOWED, call, clock, demoSession, req, testEnv } from './helpers'
import {
  db,
  expectError,
  FakeAi,
  HEARD,
  insertMessage,
  REPLY,
  REPLY_2,
  run,
  setUnitsToday,
  sha8,
  speakReq,
  spokenRows,
  tone,
  TWO_S,
  unitsToday,
} from './d5-helpers'
import { insertAccount, pairedSession } from './sync-fakes'

const T0 = 1_795_000_000
const MAIL = 'mail-0' // Marco, demo
const MARCO = {
  name: 'Marco',
  summary: 'Friday 6 am shift cover request',
  draft: 'Hi Marco, yes I can cover the 6 am start on line 1 on Friday. Let me know if you need anything else.',
  alt2: "Sorry, I can't cover the 6 am shift on Friday.",
  address: 'marco.bellini@northline-automation.example.com',
}

let logs: string[]
beforeEach(() => {
  clock.t = T0
  logs = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '))
    })
})

const speakLines = () => logs.filter((l) => l.includes('"api.items.speak"') && l.includes('"outcome"')).map((l) => JSON.parse(l) as Record<string, unknown>)

async function pairedSetup(): Promise<{ token: string; accountId: number }> {
  const token = await pairedSession()
  const acct = await db.prepare('SELECT id FROM accounts').first<{ id: number }>()
  await insertMessage(acct!.id, 'm1')
  return { token, accountId: acct!.id }
}

describe('wavOf and the speech call (§ 3.3)', () => {
  it('writes the 44-byte header of a 16 kHz mono 16-bit WAV in front of the samples, byte for byte', () => {
    const out = wavOf(new Uint8Array([1, 2, 3, 4]))
    // prettier-ignore
    expect(Array.from(out)).toEqual([
      0x52, 0x49, 0x46, 0x46, 40, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, // RIFF, 36 + 4, WAVE
      0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, 1, 0, // fmt , 16, format 1, 1 channel
      0x80, 0x3e, 0, 0, 0x00, 0x7d, 0, 0, 2, 0, 16, 0, // 16000, 32000, block align 2, 16 bits
      0x64, 0x61, 0x74, 0x61, 4, 0, 0, 0, 1, 2, 3, 4, // data, 4, the samples
    ])
    const big = wavOf(new Uint8Array(320_000))
    expect(big.byteLength).toBe(320_044)
    expect(new DataView(big.buffer).getUint32(4, true)).toBe(320_036)
    expect(new DataView(big.buffer).getUint32(40, true)).toBe(320_000)
  })

  it('base64Of and its fallback loop = the standard base64 of the bytes (checked against btoa, every padding case)', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 100_000, 100_001, 320_044]) {
      const clip = tone(n + (n % 2)).subarray(0, n)
      for (let i = 0; i < n; i += 97) clip[i] = (i * 7) & 255 // every byte value shows up, not only the tone's
      let s = ''
      for (const b of clip) s += String.fromCharCode(b)
      expect(base64Of(clip), `base64Of ${n}`).toBe(btoa(s))
      expect(base64Loop(clip), `base64Loop ${n}`).toBe(btoa(s))
    }
  })

  it('heard: NFKC, control characters out, white space runs made one space, trimmed, cut at 300 characters', () => {
    expect(heardOf('  Say\u0007 Thursday\n\n at\ttwo ﬁne  ')).toBe('Say Thursday at two fine')
    expect(heardOf('\u0000\u001b')).toBe('')
    expect(Array.from(heardOf('a'.repeat(400))).length).toBe(300)
  })

  it('the speech call gets exactly { audio: base64 of header + samples, language: "en", vad_filter: true }', async () => {
    const token = await demoSession()
    const ai = new FakeAi()
    const clip = tone(TWO_S)
    const res = await run(speakReq(MAIL, token, clip), { ai })
    expect(res.status).toBe(200)
    expect(ai.stts).toHaveLength(1)
    const { input } = ai.stts[0]!
    expect(Object.keys(input).sort()).toEqual(['audio', 'language', 'vad_filter'])
    expect(input.language).toBe('en')
    expect(input.vad_filter).toBe(true)
    const decoded = Uint8Array.from(atob(String(input.audio)), (c) => c.charCodeAt(0))
    expect(decoded.byteLength).toBe(44 + TWO_S)
    const h = new DataView(decoded.buffer)
    expect(String.fromCharCode(...decoded.subarray(0, 4), ...decoded.subarray(8, 16), ...decoded.subarray(36, 40))).toBe('RIFFWAVEfmt data')
    expect([h.getUint32(4, true), h.getUint32(16, true), h.getUint16(20, true), h.getUint16(22, true)]).toEqual([TWO_S + 36, 16, 1, 1])
    expect([h.getUint32(24, true), h.getUint32(28, true), h.getUint16(32, true), h.getUint16(34, true), h.getUint32(40, true)]).toEqual([
      16_000, 32_000, 2, 16, TWO_S,
    ])
    expect(Array.from(decoded.subarray(44))).toEqual(Array.from(clip))
  })
})

describe('the checks a to k, in their order: a request that fails two checks gets the earlier one (§ 3.2)', () => {
  const ODD = new Uint8Array(12_801)

  it('a. VOICE absent, "off", "ON" → 404 before anything else; the items answer says "voice":false', async () => {
    const token = await demoSession()
    for (const v of [undefined, 'off', 'ON', ' on', 'true']) {
      const e = testEnv({ VOICE: v })
      const ai = new FakeAi()
      await expectError(await run(speakReq(MAIL, null, ODD, { type: 'text/plain' }), { env: e, ai }), 404, 'not_found')
      await expectError(await run(speakReq(MAIL, token, tone(TWO_S)), { env: e, ai }), 404, 'not_found')
      expect(ai.calls).toHaveLength(0)
      const items = (await (await call(req('/api/items', { token }), { env: e })).json()) as { voice: unknown }
      expect(items.voice).toBe(false)
    }
    const on = (await (await call(req('/api/items', { token }))).json()) as { voice: unknown; mode: string; items: unknown[] }
    expect(on.voice).toBe(true)
    expect(Object.keys(on).sort()).toEqual(['items', 'mode', 'voice'])
  })

  it('b. no valid session → 401 (before the item and the request checks)', async () => {
    await expectError(await run(speakReq('nope', null, ODD, { type: 'text/plain' }), { ai: new FakeAi() }), 401, 'unauthorized')
    await expectError(await run(speakReq(MAIL, 'not-a-token', tone(TWO_S)), { ai: new FakeAi() }), 401, 'unauthorized')
  })

  it('c. paired: not on today\'s list → 401, a dead grant → 403 (before the item: an unknown id is not looked at)', async () => {
    const { token } = await pairedSetup()
    const ai = new FakeAi()
    const off = testEnv({ ALLOWED_ACCOUNTS: 'someone.else@example.org' })
    await expectError(await run(speakReq('unknown-id', token, ODD, { type: 'text/plain' }), { env: off, ai }), 401, 'unauthorized')
    await expectError(await run(speakReq('m1', token, tone(TWO_S)), { env: off, ai }), 401, 'unauthorized')
    await db.prepare('UPDATE accounts SET needs_signin = 1').run()
    await expectError(await run(speakReq('unknown-id', token, ODD, { type: 'text/plain' }), { ai }), 403, 'signin_needed')
    expect(ai.calls).toHaveLength(0)
  })

  it('d. an unknown item → 404 · a handled one → 409 already_handled (before the limits and the request checks)', async () => {
    const token = await demoSession()
    await expectError(await run(speakReq('nope', token, ODD, { type: 'text/plain' }), { ai: new FakeAi() }), 404, 'not_found')
    await expectError(await run(speakReq('../x', token, ODD), { ai: new FakeAi() }), 404, 'not_found')
    expect((await call(req(`/api/items/${MAIL}/skip`, { method: 'POST', token }))).status).toBe(200)
    await expectError(await run(speakReq(MAIL, token, ODD, { type: 'text/plain' }), { ai: new FakeAi() }), 409, 'already_handled')
  })

  it('e. the 13th clip of a session within the hour → 429 rate_limited, before the request is read', async () => {
    const token = await demoSession()
    const ai = new FakeAi()
    for (let i = 0; i < 12; i++) expect((await run(speakReq(MAIL, token, tone(TWO_S)), { ai })).status).toBe(200)
    expect(ai.calls).toHaveLength(24)
    await expectError(await run(speakReq(MAIL, token, tone(TWO_S)), { ai }), 429, 'rate_limited')
    await expectError(await run(speakReq(MAIL, token, ODD, { type: 'text/plain' }), { ai }), 429, 'rate_limited')
    expect(ai.calls).toHaveLength(24)
    // an hour later the session may speak again
    clock.t += 3601
    expect((await run(speakReq(MAIL, token, tone(TWO_S)), { ai })).status).toBe(200)
  })

  it('e. 30 per address per hour, all sessions together → the 31st gets 429', async () => {
    const ip = '198.51.100.77'
    const tokens = [await demoSession(ip), await demoSession(ip), await demoSession(ip), await demoSession(ip)]
    let n = 0
    for (const t of tokens.slice(0, 3))
      for (let i = 0; i < (n < 24 ? 12 : 6) && n < 30; i++, n++)
        await expectError(await run(speakReq(MAIL, t, ODD, { ip, type: 'text/plain' }), { ai: new FakeAi() }), 400, 'bad_request')
    expect(n).toBe(30)
    await expectError(await run(speakReq(MAIL, tokens[3]!, tone(TWO_S), { ip }), { ai: new FakeAi() }), 429, 'rate_limited')
  })

  it('e. 40 per address per UTC day (gate, review note 1): the 41st gets 429 even an hour later; the next day it may speak again', async () => {
    const ip = '198.51.100.78'
    const bad = async (t: string) => expectError(await run(speakReq(MAIL, t, ODD, { ip, type: 'text/plain' }), { ai: new FakeAi() }), 400, 'bad_request')
    // hour 1: 30 tries (the hourly limit of the address), three sessions
    const first = [await demoSession(ip), await demoSession(ip), await demoSession(ip)]
    for (let n = 0; n < 30; n++) await bad(first[Math.floor(n / 12)]!)
    // hour 2 (same UTC day): 10 more = 40 today
    clock.t += 3601
    const later = await demoSession(ip)
    for (let n = 0; n < 10; n++) await bad(later)
    const ai = new FakeAi()
    await expectError(await run(speakReq(MAIL, later, tone(TWO_S), { ip }), { ai }), 429, 'rate_limited')
    expect(ai.calls).toHaveLength(0)
    // another address is not touched by it
    const other = await demoSession('198.51.100.79')
    expect((await run(speakReq(MAIL, other, tone(TWO_S), { ip: '198.51.100.79' }), { ai })).status).toBe(200)
    // the next UTC day the first address may speak again (a new session: the demo session lives two hours)
    clock.t += 86_400
    const next = await demoSession(ip)
    expect((await run(speakReq(MAIL, next, tone(TWO_S), { ip }), { ai })).status).toBe(200)
  })

  it('f. the request → 400 (type, base, size, odd length) · 409 stale_draft · 422 not_heard, all before the budget', async () => {
    // two sessions: e (12 per session per hour) counts every request, refused or not
    const tokens = [await demoSession(), await demoSession()]
    let k = 0
    await setUnitsToday(3000) // g would refuse: f still answers first
    const ai = new FakeAi()
    const f = (body: Uint8Array, o: { base?: string; type?: string | null } = {}) =>
      run(speakReq(MAIL, tokens[Math.floor(k++ / 10)]!, body, o), { ai })
    await expectError(await f(tone(TWO_S), { type: 'audio/wav' }), 400, 'bad_request')
    await expectError(await f(tone(TWO_S), { type: null }), 400, 'bad_request')
    for (const b of ['6', '-1', '1.0', 'x', '', '01']) await expectError(await f(tone(TWO_S), { base: b }), 400, 'bad_request')
    await expectError(await f(tone(TWO_S), { base: '1&base=2' }), 400, 'bad_request') // two `base`
    await expectError(await f(new Uint8Array(320_002)), 400, 'bad_request')
    await expectError(await f(new Uint8Array(12_801)), 400, 'bad_request')
    await expectError(await f(new Uint8Array(2_001)), 400, 'bad_request') // odd AND short: 400 comes first
    await expectError(await f(tone(TWO_S), { base: '5' }), 409, 'stale_draft') // no stored spoken draft
    await expectError(await f(new Uint8Array(12_798)), 422, 'not_heard')
    await expectError(await f(new Uint8Array(2_000), { base: '5' }), 409, 'stale_draft') // 409 before 422
    expect(ai.calls).toHaveLength(0)
    // the edges that pass f: 12,800 and 320,000 bytes reach g (the budget)
    await expectError(await f(new Uint8Array(12_800)), 429, 'daily_cap')
    await expectError(await f(new Uint8Array(320_000)), 429, 'daily_cap')
  })

  it('f. a body over 320,000 bytes is refused on its declared length, without reading it', async () => {
    const token = await demoSession()
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1
        c.enqueue(new Uint8Array(64_000))
        if (pulled > 10) c.close()
      },
    })
    const r = new Request(`https://brief.appfinishers.com/api/items/${MAIL}/speak`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'content-length': '320002', 'cf-connecting-ip': '203.0.113.7' },
      body,
      duplex: 'half',
    } as RequestInit)
    await expectError(await run(r, { ai: new FakeAi() }), 400, 'bad_request')
    expect(pulled).toBeLessThanOrEqual(1)
  })

  it('g. the day\'s budget reached → 429 daily_cap with NO Workers AI call', async () => {
    const token = await demoSession()
    const ai = new FakeAi()
    await setUnitsToday(2999)
    expect((await run(speakReq(MAIL, token, tone(TWO_S)), { ai })).status).toBe(200) // under: allowed (then over)
    expect(await unitsToday()).toBe(2999 + 2 + 10)
    await expectError(await run(speakReq(MAIL, token, tone(TWO_S)), { ai }), 429, 'daily_cap')
    expect(ai.calls).toHaveLength(2)
    await setUnitsToday(3000)
    await expectError(await run(speakReq(MAIL, token, tone(TWO_S)), { ai }), 429, 'daily_cap')
    expect(ai.calls).toHaveLength(2)
    // VOICE_DAILY_NEURONS is read: a higher cap lets it through
    expect((await run(speakReq(MAIL, token, tone(TWO_S)), { ai, env: testEnv({ VOICE_DAILY_NEURONS: '5000' }) })).status).toBe(200)
  })

  it('h. no Workers AI client (no binding, no AI_BASE) → 502 voice_failed, logged at "config"', async () => {
    const token = await demoSession()
    await expectError(await run(speakReq(MAIL, token, tone(TWO_S)), { ai: null }), 502, 'voice_failed')
    expect(speakLines().at(-1)).toMatchObject({ outcome: 'failed', at: 'config', neurons: 0 })
  })

  it('h. a speech error and a hang → 502 voice_failed, units still counted, no rewrite', async () => {
    const token = await demoSession()
    for (const mode of ['error', 'hang', 'notext'] as const) {
      const ai = new FakeAi()
      ai.stt = mode
      const before = await unitsToday()
      await expectError(await run(speakReq(MAIL, token, tone(TWO_S)), { ai }), 502, 'voice_failed')
      expect(ai.llms).toHaveLength(0)
      // no usage in the answer (or no answer): ceil(2 s × 0.8) + 1 = 3; with usage 1.56 → 2
      expect((await unitsToday()) - before).toBe(mode === 'notext' ? 2 : 3)
      expect(speakLines().at(-1)).toMatchObject({ outcome: 'failed', at: 'stt' })
    }
    expect(await spokenRows()).toEqual([])
  })

  it('h. silence both ways (empty text; duration_after_vad 0 with a made-up text) → 422 not_heard, units counted', async () => {
    const token = await demoSession()
    for (const mode of ['silence', 'vad0'] as const) {
      const ai = new FakeAi()
      ai.stt = mode
      const before = await unitsToday()
      await expectError(await run(speakReq(MAIL, token, tone(TWO_S)), { ai }), 422, 'not_heard')
      expect(ai.llms).toHaveLength(0)
      expect((await unitsToday()) - before).toBe(2)
      expect(speakLines().at(-1)).toMatchObject({ outcome: 'not_heard', at: 'stt', neurons: 2 })
    }
  })

  it('i. a rewrite failure → 502 voice_failed, nothing stored, every call\'s units counted', async () => {
    const token = await demoSession()
    const cases = [
      ['long', 2, 2 + 10 + 10],
      ['link', 2, 2 + 10 + 10],
      ['error', 1, 2 + 10],
      ['hang', 1, 2 + 10],
    ] as const
    for (const [mode, tries, units] of cases) {
      const ai = new FakeAi()
      ai.llm = mode
      const before = await unitsToday()
      await expectError(await run(speakReq(MAIL, token, tone(TWO_S)), { ai }), 502, 'voice_failed')
      expect(ai.llms).toHaveLength(tries)
      expect((await unitsToday()) - before).toBe(units)
      expect(speakLines().at(-1)).toMatchObject({ outcome: 'failed', at: 'llm', tries, neurons: units })
    }
    expect(await spokenRows()).toEqual([])
  })

  it('j. the item handled while the rewrite ran → 409 already_handled, nothing stored (demo and paired)', async () => {
    const token = await demoSession()
    const ai = new FakeAi()
    ai.onLlm = async () => {
      await call(req(`/api/items/${MAIL}/skip`, { method: 'POST', token }))
    }
    await expectError(await run(speakReq(MAIL, token, tone(TWO_S)), { ai }), 409, 'already_handled')
    expect(await spokenRows()).toEqual([])
    const p = await pairedSetup()
    const ai2 = new FakeAi()
    ai2.onLlm = async () => {
      await db.prepare("UPDATE messages SET handled_at = ?1, handled_action = 'skip' WHERE msg_id = 'm1'").bind(clock.t).run()
    }
    await expectError(await run(speakReq('m1', p.token, tone(TWO_S)), { ai: ai2 }), 409, 'already_handled')
    expect(await db.prepare("SELECT spoken_draft FROM messages WHERE msg_id = 'm1'").first()).toEqual({ spoken_draft: null })
  })

  it('k. 200 {"draft","rev"} and nothing else; the demo spoken row holds the draft; rev = its SHA-256, 8 hex', async () => {
    const token = await demoSession()
    const ai = new FakeAi()
    const res = await run(speakReq(MAIL, token, tone(TWO_S)), { ai })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { draft: string; rev: string }
    expect(Object.keys(body).sort()).toEqual(['draft', 'rev'])
    expect(body).toEqual({ draft: REPLY, rev: await sha8(REPLY) })
    expect(body.rev).toMatch(/^[0-9a-f]{8}$/)
    const rows = await spokenRows()
    expect(rows.map((r) => [r.item_id, r.draft])).toEqual([[MAIL, REPLY]])
    const sess = await db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?1').bind(rows[0]!.token_hash).first<{ expires_at: number }>()
    expect(sess).not.toBeNull()
    expect(await db.prepare('SELECT expires_at, created_at FROM spoken').first()).toEqual({ expires_at: sess!.expires_at, created_at: T0 })
    expect(await unitsToday()).toBe(12)
    expect(speakLines().at(-1)).toEqual({
      route: 'api.items.speak', outcome: 'draft', at: 'done', seconds: 2, ms_stt: expect.any(Number), ms_llm: expect.any(Number), tries: 1, neurons: 12,
    })
  })
})

describe('the rewrite gets the four fields of the text `base` names, nothing else (§ 3.4, 3.5)', () => {
  it('base 0 = the draft, 2 = the second alternative, 5 = the stored spoken draft (the changes add up)', async () => {
    const token = await demoSession()
    const ai = new FakeAi()
    ai.llm = 'second'
    expect((await run(speakReq(MAIL, token, tone(TWO_S)), { ai })).status).toBe(200)
    expect(ai.lastFields()).toEqual({ name: MARCO.name, summary: MARCO.summary, current: MARCO.draft, heard: HEARD })
    expect((await run(speakReq(MAIL, token, tone(TWO_S), { base: '2' }), { ai })).status).toBe(200)
    expect(ai.lastFields()).toEqual({ name: MARCO.name, summary: MARCO.summary, current: MARCO.alt2, heard: HEARD })
    const third = await run(speakReq(MAIL, token, tone(TWO_S), { base: '5' }), { ai })
    expect(await third.json()).toEqual({ draft: REPLY_2, rev: await sha8(REPLY_2) })
    expect(ai.lastFields()).toEqual({ name: MARCO.name, summary: MARCO.summary, current: REPLY_2, heard: HEARD })
    // the model input: one system message + one user message (the four fields); never the address or the full name
    for (const c of ai.llms) {
      expect(Object.keys(c.input).sort()).toEqual(['max_tokens', 'messages', 'temperature'])
      const msgs = c.input.messages as Array<{ role: string }>
      expect(msgs.map((m) => m.role)).toEqual(['system', 'user'])
      expect(JSON.stringify(c.input)).not.toContain('Bellini')
      expect(JSON.stringify(c.input)).not.toContain(MARCO.address)
    }
    expect(ai.llms[0]!.model).toBe(SPOKEN_MODEL)
    expect(ai.stts[0]!.model).toBe(MODEL_STT)
  })

  it('a second clip replaces the first: one row per item and session (demo), one column (paired)', async () => {
    const token = await demoSession()
    const ai = new FakeAi()
    ai.llm = 'second'
    await run(speakReq(MAIL, token, tone(TWO_S)), { ai })
    await run(speakReq(MAIL, token, tone(TWO_S)), { ai })
    expect((await spokenRows()).map((r) => r.draft)).toEqual([REPLY_2])
    const p = await pairedSetup()
    const ai2 = new FakeAi()
    ai2.llm = 'second'
    const first = await run(speakReq('m1', p.token, tone(TWO_S)), { ai: ai2 })
    expect(await first.json()).toEqual({ draft: REPLY, rev: await sha8(REPLY) })
    expect(await db.prepare("SELECT spoken_draft, spoken_at FROM messages WHERE msg_id = 'm1'").first()).toEqual({ spoken_draft: REPLY, spoken_at: T0 })
    clock.t += 5
    await run(speakReq('m1', p.token, tone(TWO_S)), { ai: ai2 })
    expect(await db.prepare("SELECT spoken_draft, spoken_at FROM messages WHERE msg_id = 'm1'").first()).toEqual({ spoken_draft: REPLY_2, spoken_at: T0 + 5 })
    // the paired items list does not change: no spoken draft in it
    const items = (await (await call(req('/api/items', { token: p.token }))).json()) as { items: Array<Record<string, unknown>> }
    expect(JSON.stringify(items)).not.toContain(REPLY_2)
  })

  it('demo: another session never sees this session\'s spoken draft (base 5 → 409 stale_draft)', async () => {
    const a = await demoSession()
    const b = await demoSession()
    expect((await run(speakReq(MAIL, a, tone(TWO_S)), { ai: new FakeAi() })).status).toBe(200)
    await expectError(await run(speakReq(MAIL, b, tone(TWO_S), { base: '5' }), { ai: new FakeAi() }), 409, 'stale_draft')
  })
})

describe('paired (§ 6.1)', () => {
  it('another account\'s item → 404, nothing called, nothing stored', async () => {
    const { token } = await pairedSetup()
    const other = await insertAccount('second@example.net')
    await insertMessage(other, 'm2')
    const ai = new FakeAi()
    await expectError(await run(speakReq('m2', token, tone(TWO_S)), { ai }), 404, 'not_found')
    expect(ai.calls).toHaveLength(0)
    expect(await db.prepare("SELECT spoken_draft FROM messages WHERE msg_id = 'm2'").first()).toEqual({ spoken_draft: null })
  })

  it('a handled message → 409 already_handled; the gate needs no send scope (REAL_SEND on, readonly grant → 200)', async () => {
    const { token } = await pairedSetup()
    const on = testEnv({ REAL_SEND: 'on' })
    expect((await run(speakReq('m1', token, tone(TWO_S)), { ai: new FakeAi(), env: on })).status).toBe(200)
    await db.prepare("UPDATE messages SET handled_at = ?1, handled_action = 'send', handled_choice = 0 WHERE msg_id = 'm1'").bind(T0).run()
    await expectError(await run(speakReq('m1', token, tone(TWO_S)), { ai: new FakeAi(), env: on }), 409, 'already_handled')
  })
})

describe('what leaves the route and the log (§ 1.3, § 3.2)', () => {
  it('no log line and no answer holds the clip, what was heard, the draft, a name or an address', async () => {
    const token = await demoSession()
    const p = await pairedSetup()
    const answers: string[] = []
    const modes: Array<[string, string]> = [['ok', 'ok'], ['silence', 'ok'], ['error', 'ok'], ['ok', 'long'], ['ok', 'link'], ['ok', 'long-once']]
    for (const [stt, llm] of modes) {
      for (const [id, t] of [[MAIL, token], ['m1', p.token]] as const) {
        const ai = new FakeAi()
        ai.stt = stt as FakeAi['stt']
        ai.llm = llm as FakeAi['llm']
        const res = await run(speakReq(id, t, tone(TWO_S)), { ai })
        const text = await res.text()
        answers.push(text)
        const body = JSON.parse(text) as Record<string, unknown>
        expect(Object.keys(body).sort()).toEqual(res.status === 200 ? ['draft', 'rev'] : ['error'])
      }
    }
    const clipB64 = base64Of(wavOf(tone(TWO_S)))
    const forbidden = [HEARD, REPLY, 'Thursday', 'Marco', 'Bellini', MARCO.address, ALLOWED, 'example.com', clipB64.slice(0, 24), clipB64.slice(4000, 4024), 'UklGR']
    expect(logs.length).toBeGreaterThan(12)
    for (const l of logs) for (const f of forbidden) expect(l, `log line holds ${f}`).not.toContain(f)
    for (const a of answers.filter((x) => !x.includes('"draft"'))) for (const f of forbidden) expect(a).not.toContain(f)
    // one speak line per request, its keys exactly these
    expect(speakLines()).toHaveLength(modes.length * 2)
    const KEYS = ['at', 'ms_llm', 'ms_stt', 'neurons', 'outcome', 'route', 'seconds', 'tries']
    for (const l of speakLines()) expect(Object.keys(l).filter((k) => k !== 'why').sort()).toEqual(KEYS)
    // `why` (gate): only on a failed speech call or rewrite, a code and numbers, never text
    const whys = speakLines().map((l) => [l.outcome, l.at, l.why])
    for (const [outcome, , why] of whys) expect(why === undefined).toBe(outcome !== 'failed')
    for (const [, , why] of whys) if (why !== undefined) expect(why).toMatch(/^[a-z_]+( [a-z_]+)?( \d+)?$/)
    expect(whys.filter(([o]) => o === 'failed').map(([, at, why]) => `${at}:${why}`).sort()).toEqual(['llm:too_long 235', 'llm:too_long 235', 'llm:unsafe link', 'llm:unsafe link', 'stt:error', 'stt:error'])
    // what was heard is stored nowhere: no table of D1 holds it
    for (const t of ['spoken', 'messages', 'counters', 'sessions', 'handled', 'triage_results']) {
      const all = JSON.stringify((await db.prepare(`SELECT * FROM ${t}`).all()).results)
      expect(all, t).not.toContain('Say Thursday')
    }
  })
})

describe('the demo spoken rows leave with the session (§ 3.5)', () => {
  it('logout deletes this session\'s rows (not another session\'s)', async () => {
    const a = await demoSession()
    const b = await demoSession()
    await run(speakReq(MAIL, a, tone(TWO_S)), { ai: new FakeAi() })
    await run(speakReq('mail-1', a, tone(TWO_S)), { ai: new FakeAi() })
    await run(speakReq(MAIL, b, tone(TWO_S)), { ai: new FakeAi() })
    expect(await spokenRows()).toHaveLength(3)
    expect((await call(req('/api/session/logout', { method: 'POST', token: a }))).status).toBe(200)
    const left = await spokenRows()
    expect(left).toHaveLength(1)
    expect((await call(req('/api/session/logout', { method: 'POST', token: a }))).status).toBe(401)
    expect((await call(req('/api/session/logout', { method: 'POST', token: b }))).status).toBe(200)
    expect(await spokenRows()).toEqual([])
  })

  it('the purge deletes the rows of an expired session', async () => {
    const a = await demoSession()
    await run(speakReq(MAIL, a, tone(TWO_S)), { ai: new FakeAi() })
    expect(await spokenRows()).toHaveLength(1)
    clock.t += 7200 + 1 // the demo session's 2 hours are over; a new session runs the lazy purge
    await demoSession('192.0.2.200')
    expect(await spokenRows()).toEqual([])
  })
})

describe('counting (§ 6.4): one speak request, worst case = paired, base 5, a retry in the rewrite', () => {
  it('12 D1 statements (10 round trips) + 3 Workers AI calls = 15, under 20', async () => {
    const { token } = await pairedSetup()
    await run(speakReq('m1', token, tone(TWO_S)), { ai: new FakeAi() }) // a stored spoken draft for base 5
    const real = (env as Env).DB
    const n = { statements: 0, trips: 0 }
    const counted = new Proxy(real, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            n.statements += 1
            const st = target.prepare(sql)
            return new Proxy(st, {
              get(s, k) {
                const v = Reflect.get(s, k, s) as unknown
                if (k === 'bind') return (...args: unknown[]) => wrapRun((v as (...a: unknown[]) => D1PreparedStatement).apply(s, args))
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(s) : v
              },
            })
          }
        if (key === 'batch')
          return (stmts: D1PreparedStatement[]) => {
            n.trips += 1
            return target.batch(stmts.map(unwrap))
          }
        const v = Reflect.get(target, key, target) as unknown
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
      },
    })
    const RAW = Symbol('raw')
    function wrapRun(st: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(st, {
        get(s, k) {
          if (k === RAW) return s
          const v = Reflect.get(s, k, s) as unknown
          if (k === 'first' || k === 'run' || k === 'all' || k === 'raw')
            return (...a: unknown[]) => {
              n.trips += 1
              return (v as (...x: unknown[]) => unknown).apply(s, a)
            }
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(s) : v
        },
      })
    }
    function unwrap(st: D1PreparedStatement): D1PreparedStatement {
      return ((st as unknown as Record<symbol, unknown>)[RAW] as D1PreparedStatement | undefined) ?? st
    }
    const ai = new FakeAi()
    ai.llm = 'long-once'
    const res = await run(speakReq('m1', token, tone(TWO_S), { base: '5' }), { ai, env: testEnv({ DB: counted as D1Database }) })
    expect(res.status).toBe(200)
    expect(ai.calls).toHaveLength(3)
    // session · account · item · 3 limits (one batch) · the stored spoken draft · the budget · units ×3 · the store
    expect(n).toEqual({ statements: 12, trips: 10 })
    expect(n.statements + ai.calls.length).toBeLessThan(20)
  })
})
