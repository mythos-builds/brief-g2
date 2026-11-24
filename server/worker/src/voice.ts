// « Speak a change » (BRIEF-D5 § 3.2, 3.3, 3.5, 3.8): the WAV header, speech to text through Workers AI, the units of
// the day, the two `ai` clients, the stored spoken draft. Speaking never sends: this module only reads, counts and
// stores a checked draft. The clip is never stored and never logged; what was heard is never stored, logged or
// returned (it lives in one local variable of the request, then goes to the rewrite).
import type { AiRun } from '../../triage/spoken.ts'
import { sha256hex } from './crypto.ts'
import type { Deps, Env } from './env.ts'
import { DAY, dayKey, endOfDay } from './limits.ts'

export const MODEL_STT = '@cf/openai/whisper-large-v3-turbo'
export const SAMPLE_RATE = 16_000
export const BYTES_PER_SECOND = 32_000 // 16,000 samples of 2 bytes
export const CLIP_MIN_BYTES = 12_800 // 0.4 s
export const CLIP_MAX_BYTES = 320_000 // 10 s
export const STT_LIMIT_MS = 10_000
export const HEARD_MAX = 300
export const DEFAULT_VOICE_DAILY_NEURONS = 3000
/** The units of one rewrite call whose answer says none (§ 3.4), also counted for a call that failed or hung. */
export const LLM_DEFAULT_UNITS = 10
export const REV_RE = /^[0-9a-f]{8}$/

/** Offered only when VOICE is exactly "on" (not "ON", not "true"). */
export function voiceOn(env: Env): boolean {
  return env.VOICE === 'on'
}

/** VOICE_DAILY_NEURONS: a whole number ≥ 0; absent, empty or anything else = the default 3000. */
export function voiceDailyNeurons(env: Env): number {
  const raw = (env.VOICE_DAILY_NEURONS ?? '').trim()
  const n = raw === '' ? DEFAULT_VOICE_DAILY_NEURONS : Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_VOICE_DAILY_NEURONS
}

/**
 * The 44-byte header of a 16 kHz mono 16-bit PCM WAV, then the samples (§ 3.3). ONE pure function. Workers AI refuses
 * raw samples with no header (« 3030: Failed to decode audio file », PREP.md [2026-11-23 22:38] point 2).
 */
export function wavOf(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength)
  const v = new DataView(out.buffer)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + pcm.byteLength, true) // the size of everything after these 8 bytes
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true) // the fmt chunk's size
  v.setUint16(20, 1, true) // format 1 = PCM
  v.setUint16(22, 1, true) // 1 channel
  v.setUint32(24, SAMPLE_RATE, true)
  v.setUint32(28, BYTES_PER_SECOND, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  v.setUint32(40, pcm.byteLength, true)
  out.set(pcm, 44)
  return out
}

const B64 = Uint8Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', (c) => c.charCodeAt(0))
const PAD = 61 // '='

/**
 * Standard base64 (with padding). The Free plan gives a request 10 ms of CPU: the runtime's own
 * `Uint8Array.prototype.toBase64` when it has one, else one pass over the bytes into a byte buffer (measured
 * 2026-11-23 in Node 24 on a 10-second clip: String.fromCharCode + btoa took about 18 ms, this loop a few ms).
 */
export function base64Of(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  return typeof native === 'function' ? native.call(bytes) : base64Loop(bytes)
}

/** The fallback of base64Of: one pass, three bytes → four characters, `=` padding. */
export function base64Loop(bytes: Uint8Array): string {
  const n = bytes.length
  const out = new Uint8Array(Math.ceil(n / 3) * 4)
  let o = 0
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out[o] = B64[v >> 18]!
    out[o + 1] = B64[(v >> 12) & 63]!
    out[o + 2] = B64[(v >> 6) & 63]!
    out[o + 3] = B64[v & 63]!
    o += 4
  }
  if (i < n) {
    const v = (bytes[i]! << 16) | (i + 1 < n ? bytes[i + 1]! << 8 : 0)
    out[o] = B64[v >> 18]!
    out[o + 1] = B64[(v >> 12) & 63]!
    out[o + 2] = i + 1 < n ? B64[(v >> 6) & 63]! : PAD
    out[o + 3] = PAD
  }
  return new TextDecoder().decode(out)
}

/**
 * What was heard, made safe (§ 3.3): NFKC · control characters removed (a control character that is white space,
 * such as a line end, becomes a space first, so two words never stick together) · runs of white space made one space
 * · trimmed · cut at 300 characters (code points, so no half of a pair is left).
 */
export function heardOf(text: string): string {
  const t = text
    .normalize('NFKC')
    .replace(/[\t\n\v\f\r\x1c-\x1f\x85]/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(t).slice(0, HEARD_MAX).join('').trim()
}

/** The units of one speech call (§ 3.3): ceil(usage.neurons) when it is a finite number above 0, else ceil(s×0.8)+1. */
export function sttUnits(answer: unknown, seconds: number): number {
  const n = (answer as { usage?: { neurons?: unknown } } | null | undefined)?.usage?.neurons
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.ceil(n) : Math.ceil(seconds * 0.8) + 1
}

/** The units of one rewrite call (§ 3.4): ceil(usage.neurons), 10 when absent. */
export function llmUnits(answer: unknown): number {
  const n = (answer as { usage?: { neurons?: unknown } } | null | undefined)?.usage?.neurons
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.ceil(n) : LLM_DEFAULT_UNITS
}

export type Heard =
  | { kind: 'heard'; heard: string; units: number }
  | { kind: 'silent'; units: number }
  | { kind: 'failed'; reason: 'error' | 'timeout' | 'bad_answer'; units: number }

/**
 * Speech to text (§ 3.3): ONE call, `{ audio: <base64 of the WAV>, language: "en", vad_filter: true }`, a time limit.
 * Nothing heard = `text` empty after the clean-up, or `transcription_info.duration_after_vad` present and 0. An error
 * or the time limit still counts units (the estimate from the clip's length): the call may have run.
 */
export async function speechToText(ai: AiRun, pcm: Uint8Array, limitMs: number = STT_LIMIT_MS): Promise<Heard> {
  const seconds = pcm.byteLength / BYTES_PER_SECOND
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), limitMs)
  })
  let answer: unknown
  try {
    const input = { audio: base64Of(wavOf(pcm)), language: 'en', vad_filter: true }
    const got = await Promise.race([
      Promise.resolve()
        .then(() => ai(MODEL_STT, input))
        .then(
          (a) => ({ a }),
          () => 'error' as const,
        ),
      timeout,
    ])
    if (got === 'timeout' || got === 'error') return { kind: 'failed', reason: got, units: sttUnits(undefined, seconds) }
    answer = got.a
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const units = sttUnits(answer, seconds)
  const o = answer as { text?: unknown; transcription_info?: { duration_after_vad?: unknown } } | null | undefined
  if (typeof o?.text !== 'string') return { kind: 'failed', reason: 'bad_answer', units }
  const heard = heardOf(o.text)
  const afterVad = o.transcription_info?.duration_after_vad
  if (heard === '' || afterVad === 0) return { kind: 'silent', units }
  return { kind: 'heard', heard, units }
}

/**
 * The rewrite's `ai`, wrapped so the units of EACH call are counted as soon as it answers or fails (§ 3.2: « units are
 * counted after EACH Workers AI call, whatever comes next »). `settle()`, called once the rewrite is over, counts the
 * default units for a call still running (a hang past the time limit); a call that ends later is not counted twice.
 */
export function countedAi(ai: AiRun, add: (units: number) => Promise<void>): { run: AiRun; settle: () => Promise<void> } {
  let open = 0
  let closed = false
  const run: AiRun = async (model, input) => {
    open += 1
    let answer: unknown
    try {
      answer = await ai(model, input)
    } catch (e) {
      if (!closed) {
        open -= 1
        await add(LLM_DEFAULT_UNITS)
      }
      throw e
    }
    if (!closed) {
      open -= 1
      await add(llmUnits(answer))
    }
    return answer
  }
  const settle = async () => {
    closed = true
    const left = open
    open = 0
    if (left > 0) await add(left * LLM_DEFAULT_UNITS)
  }
  return { run, settle }
}

/**
 * The dev client (§ 3.8): POSTs the input as JSON to `${base}/ai/run/<model>` through deps.fetch and returns the
 * answer's `result`; a non-200 throws `Error("<code>: <message>")` as the binding does.
 */
export function httpAi(base: string, fetch: Deps['fetch']): AiRun {
  const root = base.replace(/\/+$/, '')
  return async (model, input) => {
    const res = await fetch(`${root}/ai/run/${model}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    if (res.status !== 200) {
      const first = (body as { errors?: Array<{ code?: unknown; message?: unknown }> } | null)?.errors?.[0]
      const code = typeof first?.code === 'number' ? first.code : res.status
      const message = typeof first?.message === 'string' ? first.message : `HTTP ${res.status}`
      throw new Error(`${code}: ${message}`)
    }
    return (body as { result?: unknown } | null)?.result
  }
}

/**
 * The `ai` of one request (§ 3.8). ENV "dev": the local fake at AI_BASE (.dev.vars only), never the binding (it
 * always reaches the live service). Otherwise: the `[ai]` binding. Neither → undefined: the route answers 502
 * voice_failed and logs `at: "config"`.
 */
export function aiOf(env: Env, fetch: Deps['fetch']): AiRun | undefined {
  if (env.ENV === 'dev') {
    const base = (env.AI_BASE ?? '').trim()
    return base ? httpAi(base, fetch) : undefined
  }
  const binding = env.AI
  return binding ? (model, input) => binding.run(model, input) : undefined
}

/** `rev` = the first 8 hex characters of the SHA-256 of the draft's UTF-8 bytes (§ 3.5). */
export async function revOf(draft: string): Promise<string> {
  return (await sha256hex(draft)).slice(0, 8)
}

/** The day's key of the units counter: `voice:<UTC date>`. */
export function voiceDayKey(now: number): string {
  return `voice:${dayKey(now)}`
}

/** Adds units to the day's counter (ONE upsert; the row lives until the day after, the key carries the date). */
export async function addUnits(db: D1Database, now: number, units: number): Promise<void> {
  if (!(units > 0)) return
  await db
    .prepare(
      `INSERT INTO counters (key, count, window_end) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET count = counters.count + ?2`,
    )
    .bind(voiceDayKey(now), Math.ceil(units), endOfDay(now) + DAY)
    .run()
}

/** Who owns a spoken draft: a paired ACCOUNT's message row, or a demo SESSION's frozen item. */
export type Owner = { kind: 'paired'; accountId: number } | { kind: 'demo'; tokenHash: string; expiresAt: number }

/** The stored spoken draft of the item (paired: the row's; demo: this session's), or null. */
export async function spokenDraft(db: D1Database, owner: Owner, itemId: string, now: number): Promise<string | null> {
  if (owner.kind === 'paired') {
    const r = await db
      .prepare('SELECT spoken_draft FROM messages WHERE account_id = ?1 AND msg_id = ?2')
      .bind(owner.accountId, itemId)
      .first<{ spoken_draft: string | null }>()
    return typeof r?.spoken_draft === 'string' ? r.spoken_draft : null
  }
  const r = await db
    .prepare('SELECT draft FROM spoken WHERE token_hash = ?1 AND item_id = ?2 AND expires_at > ?3')
    .bind(owner.tokenHash, itemId, now)
    .first<{ draft: string }>()
  return typeof r?.draft === 'string' ? r.draft : null
}

/**
 * Stores the checked draft in ONE conditional statement (§ 3.5 + check j): paired = the row changes only while it is
 * not handled; demo = the session's row is written (a new one replaces the old one) only while the item is not
 * handled by this session. false = no row changed (handled meanwhile).
 */
export async function storeSpoken(db: D1Database, owner: Owner, itemId: string, draft: string, now: number): Promise<boolean> {
  if (owner.kind === 'paired') {
    const row = await db
      .prepare(
        `UPDATE messages SET spoken_draft = ?3, spoken_at = ?4
         WHERE account_id = ?1 AND msg_id = ?2 AND state = 'done' AND handled_at IS NULL RETURNING 1 AS ok`,
      )
      .bind(owner.accountId, itemId, draft, now)
      .first()
    return row !== null
  }
  const row = await db
    .prepare(
      `INSERT INTO spoken (token_hash, item_id, draft, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM handled WHERE token_hash = ?1 AND item_id = ?2)
       ON CONFLICT (token_hash, item_id) DO UPDATE SET draft = excluded.draft, created_at = excluded.created_at,
         expires_at = excluded.expires_at
       RETURNING 1 AS ok`,
    )
    .bind(owner.tokenHash, itemId, draft, now, owner.expiresAt)
    .first()
  return row !== null
}
