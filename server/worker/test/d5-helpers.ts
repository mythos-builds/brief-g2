// Day 5 test helpers (BRIEF-D5 § 3.2, § 6): a scripted Workers AI (it answers like job B's fake of § 3.9, never the
// live service), clips made by code (a tone), the speak request, paired rows. Made-up data, example.com only.
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import type { AiRun } from '../../triage/spoken'
import { SPOKEN_MODEL } from '../../triage/spoken'
import { handle } from '../src/app'
import type { Deps, Env } from '../src/env'
import { MODEL_STT } from '../src/voice'
import { BASE, clock, type FetchStub, noFetch, testEnv } from './helpers'
import { TRIAGE_ANSWER } from './sync-fakes'

export const db = (env as Env).DB

/** What job B's fake hears and answers (§ 3.9). */
export const HEARD = 'Say Thursday at two instead, and thank him for the update.'
export const REPLY = 'Thursday at two works for me instead. Thanks for the update.'
export const REPLY_2 = 'Thursday at two works for me. Thank you for the update.'
export const LONG = `${'Thursday at two works for me instead, '.repeat(6)}thanks.`

export type SttMode = 'ok' | 'silence' | 'vad0' | 'error' | 'hang' | 'notext' | 'nousage'
export type LlmMode = 'ok' | 'second' | 'long' | 'long-once' | 'link' | 'error' | 'hang'

export interface AiCall {
  model: string
  input: Record<string, unknown>
}

/** A scripted Workers AI: records every call (model + input), answers by mode. */
export class FakeAi {
  calls: AiCall[] = []
  stt: SttMode = 'ok'
  llm: LlmMode = 'ok'
  /** Runs inside a rewrite call before it answers (e.g. the item gets handled meanwhile). */
  onLlm: (() => Promise<void>) | null = null
  private llmTries = 0

  run: AiRun = async (model, input) => {
    this.calls.push({ model, input })
    if (model === MODEL_STT) {
      const wavBytes = (atob(String(input.audio)).length - 44) / 32_000
      const usage = { neurons: 0.78 * wavBytes }
      const info = { language: 'en', duration: wavBytes, duration_after_vad: wavBytes }
      switch (this.stt) {
        case 'ok':
          return { text: HEARD, word_count: 10, transcription_info: info, usage }
        case 'nousage':
          return { text: HEARD, word_count: 10, transcription_info: info }
        case 'silence':
          return { text: '', word_count: 0, transcription_info: { ...info, duration_after_vad: 0 }, usage }
        case 'vad0':
          // a made-up text with nothing left after the voice filter = nothing heard
          return { text: 'Thank you.', word_count: 2, transcription_info: { ...info, duration_after_vad: 0 }, usage }
        case 'notext':
          return { word_count: 0, usage }
        case 'error':
          throw new Error('3030: Failed to decode audio file. Ensure it is a valid audio format.')
        case 'hang':
          return new Promise(() => {})
      }
    }
    if (model === SPOKEN_MODEL) {
      this.llmTries += 1
      if (this.onLlm) await this.onLlm()
      const usage = { neurons: 9.3 }
      switch (this.llm) {
        case 'ok':
          return { response: REPLY, usage }
        case 'second':
          return { response: this.llmTries === 1 ? REPLY : REPLY_2, usage }
        case 'long':
          return { response: LONG, usage }
        case 'long-once':
          return { response: this.llmTries === 1 ? LONG : REPLY, usage }
        case 'link':
          return { response: 'Thursday at two works, see https://example.com/times for more.', usage }
        case 'error':
          throw new Error('3040: Capacity temporarily exceeded')
        case 'hang':
          return new Promise(() => {})
      }
    }
    throw new Error(`unexpected model ${model}`)
  }

  get stts(): AiCall[] {
    return this.calls.filter((c) => c.model === MODEL_STT)
  }
  get llms(): AiCall[] {
    return this.calls.filter((c) => c.model === SPOKEN_MODEL)
  }
  /** The four fields the rewrite's last call got (its user message, parsed). */
  lastFields(): Record<string, unknown> {
    const msgs = this.llms.at(-1)!.input.messages as Array<{ role: string; content: string }>
    return JSON.parse(msgs[1]!.content) as Record<string, unknown>
  }
}

/** A clip made by code: a 440 Hz tone, signed 16-bit little-endian, mono, `bytes` long (made even by the caller). */
export function tone(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes)
  const v = new DataView(out.buffer)
  for (let i = 0; i + 1 < bytes; i += 2) v.setInt16(i, Math.round(8000 * Math.sin((2 * Math.PI * 440 * (i / 2)) / 16_000)), true)
  return out
}

export const TWO_S = 64_000 // a 2-second clip: 1.56 units by the fake (→ 2), the rewrite 9.3 (→ 10)

export function speakReq(
  id: string,
  token: string | null,
  body: Uint8Array,
  opts: { base?: string; type?: string | null; ip?: string } = {},
): Request {
  const headers: Record<string, string> = { 'cf-connecting-ip': opts.ip ?? '203.0.113.7' }
  if (token) headers.authorization = `Bearer ${token}`
  if (opts.type !== null) headers['content-type'] = opts.type ?? 'application/octet-stream'
  const q = opts.base === undefined ? '' : `?base=${opts.base}`
  return new Request(`${BASE}/api/items/${id}/speak${q}`, { method: 'POST', headers, body })
}

export async function run(
  request: Request,
  opts: { env?: Env; ai?: FakeAi | null; fetch?: FetchStub; deps?: Partial<Deps> } = {},
): Promise<Response> {
  const deps: Deps = {
    fetch: opts.fetch ?? noFetch,
    now: () => clock.t,
    ai: opts.ai === null ? undefined : opts.ai?.run,
    sttLimitMs: 200,
    llmLimitMs: 400,
    sendCallLimitMs: 50,
    ...opts.deps,
  }
  const ctx = createExecutionContext()
  const res = await handle(request, opts.env ?? testEnv(), ctx, deps)
  await waitOnExecutionContext(ctx)
  return res
}

export async function expectError(res: Response, status: number, code: string): Promise<void> {
  expect({ status: res.status, body: await res.json() }).toEqual({ status, body: { error: code } })
}

/** A stored, triaged, unhandled message of the account (as the sync leaves it). */
export async function insertMessage(accountId: number, id: string, persona = 'marco', at = clock.t - 600): Promise<void> {
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

export async function sha8(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return Array.from(d.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function unitsToday(): Promise<number> {
  const key = `voice:${new Date(clock.t * 1000).toISOString().slice(0, 10)}`
  const row = await db.prepare('SELECT count FROM counters WHERE key = ?1').bind(key).first<{ count: number }>()
  return row?.count ?? 0
}

export async function setUnitsToday(n: number): Promise<void> {
  const key = `voice:${new Date(clock.t * 1000).toISOString().slice(0, 10)}`
  await db
    .prepare('INSERT INTO counters (key, count, window_end) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET count = ?2')
    .bind(key, n, clock.t + 86_400)
    .run()
}

export async function spokenRows(): Promise<Array<{ token_hash: string; item_id: string; draft: string }>> {
  return (await db.prepare('SELECT token_hash, item_id, draft FROM spoken ORDER BY item_id').all<{ token_hash: string; item_id: string; draft: string }>())
    .results
}
