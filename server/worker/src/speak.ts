// POST /api/items/<id>/speak?base=<n> (BRIEF-D5 § 3.2), demo and paired: « Speak a change ». The clip (raw 16 kHz
// s16le mono samples) → a WAV → Workers AI speech to text → job B's rewrite → the checked draft is STORED and returned.
// Speaking never sends: this route can only store a draft (decision 1.2). The clip and what was heard are never stored,
// never logged, never returned. One log line per request: step names, counts, codes, milliseconds, units.
import { authSession } from './api.ts'
import type { Deps, Env } from './env.ts'
import { error, type ErrorCode, json, readBodyCapped } from './http.ts'
import { DEMO_ITEMS, findItem, ID_RE, type Item } from './items.ts'
import { addressKey, dayKey, endOfDay, hit, HOUR } from './limits.ts'
import { accountGate, pairedItem } from './paired.ts'
import { counterValue } from './stores.ts'
import {
  addUnits,
  BYTES_PER_SECOND,
  CLIP_MAX_BYTES,
  CLIP_MIN_BYTES,
  countedAi,
  type Owner,
  revOf,
  speechToText,
  spokenDraft,
  storeSpoken,
  voiceDailyNeurons,
  voiceDayKey,
  voiceOn,
} from './voice.ts'
import { spokenChange } from './wiring.ts'

export const SPEAK_PER_SESSION_HOUR = 12
export const SPEAK_PER_ADDRESS_HOUR = 30
/**
 * One address per UTC day (added at the day-5 gate, review note 1): at 30 an hour, one address alone could use up the
 * day's shared budget of units in a few hours, and then `daily_cap` turns the voice off for everybody until midnight.
 * 40 clips are about a fifth of the default budget.
 */
export const SPEAK_PER_ADDRESS_DAY = 40

type Outcome = 'draft' | 'not_heard' | 'failed' | 'refused'

/** The one log line of a speak request: never the clip, what was heard, the draft, a name or an address. */
interface SpeakLog {
  route: 'api.items.speak'
  outcome: Outcome
  at: string
  seconds: number
  ms_stt: number
  ms_llm: number
  tries: number
  neurons: number
}

export async function postSpeak(request: Request, env: Env, deps: Deps, id: string): Promise<Response> {
  const line: SpeakLog = { route: 'api.items.speak', outcome: 'refused', at: 'voice', seconds: 0, ms_stt: 0, ms_llm: 0, tries: 0, neurons: 0 }
  const end = (res: Response, outcome: Outcome, at: string): Response => {
    line.outcome = outcome
    line.at = at
    console.log(JSON.stringify(line))
    return res
  }
  const refuse = (code: ErrorCode, at: string, retryAfter?: number) => end(error(code, retryAfter), 'refused', at)

  // a. the switch: anything but exactly "on" = the route does not exist
  if (!voiceOn(env)) return refuse('not_found', 'voice')
  const now = deps.now()
  // b. a valid session
  const s = await authSession(request, env.DB, now)
  if (!s) return refuse('unauthorized', 'session')

  // c. paired: the account gate of day 4 WITHOUT the send scope (allow-list → 401 · dead grant → 403)
  // d. the item: unknown or not this session's / this account's → 404 · already handled → 409
  let item: Item | undefined
  let handled = false
  let owner: Owner
  if (s.mode === 'paired') {
    const gate = await accountGate(env, s.accountId, false)
    if ('error' in gate) return refuse(gate.error, 'account')
    owner = { kind: 'paired', accountId: gate.account.id }
    const got = ID_RE.test(id) ? await pairedItem(env, gate.account.id, id) : null
    item = got?.item
    handled = got?.handled ?? false
  } else {
    if (!DEMO_ITEMS) return end(error('server_error'), 'failed', 'item')
    owner = { kind: 'demo', tokenHash: s.hash, expiresAt: s.expiresAt }
    item = ID_RE.test(id) ? findItem(DEMO_ITEMS, id) : undefined
    if (item)
      handled =
        (await env.DB.prepare('SELECT 1 AS ok FROM handled WHERE token_hash = ?1 AND item_id = ?2').bind(s.hash, item.id).first()) !==
        null
  }
  if (!item) return refuse('not_found', 'item')
  if (handled) return refuse('already_handled', 'item')

  // e. the route limits: 12 per session per hour, 30 per address per hour, 40 per address per UTC day (narrowest
  // first, one batch)
  const addr = await addressKey(request)
  const refused = await hit(env.DB, now, [
    { key: `speak:session:${s.hash}`, max: SPEAK_PER_SESSION_HOUR, windowEnd: now + HOUR, code: 'rate_limited' },
    { key: `speak:addr:${addr}`, max: SPEAK_PER_ADDRESS_HOUR, windowEnd: now + HOUR, code: 'rate_limited' },
    { key: `speak:addrday:${dayKey(now)}:${addr}`, max: SPEAK_PER_ADDRESS_DAY, windowEnd: endOfDay(now), code: 'rate_limited' },
  ])
  if (refused) return refuse(refused.code, 'limits', refused.retryAfter)

  // f. the request: the type, `base`, the size (a declared or streamed body over 320,000 bytes is refused before it
  // is read in full), an odd length → 400 · `base` naming no text → 409 stale_draft · under 0.4 s → 422 not_heard
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== 'application/octet-stream') return refuse('bad_request', 'request')
  const bases = new URL(request.url).searchParams.getAll('base')
  if (bases.length > 1 || (bases.length === 1 && !/^[0-5]$/.test(bases[0]!))) return refuse('bad_request', 'request')
  const base = bases.length === 1 ? Number(bases[0]) : 0
  const pcm = await readBodyCapped(request, CLIP_MAX_BYTES)
  if (!pcm) return refuse('bad_request', 'request')
  line.seconds = Math.round((pcm.byteLength / BYTES_PER_SECOND) * 10) / 10
  if (pcm.byteLength % 2 !== 0) return refuse('bad_request', 'request')
  let current: string | null
  if (base === 0) current = item.draft
  else if (base <= 4) current = item.alts[base - 1] ?? null
  else current = await spokenDraft(env.DB, owner, item.id, now)
  if (typeof current !== 'string' || current.trim() === '') return refuse('stale_draft', 'request')
  if (pcm.byteLength < CLIP_MIN_BYTES) return end(error('not_heard'), 'not_heard', 'request')

  // g. the day's budget of Workers AI units, all users together: at or over → 429, and NO Workers AI call
  if ((await counterValue(env.DB, voiceDayKey(now))) >= voiceDailyNeurons(env)) return refuse('daily_cap', 'budget', endOfDay(now) - now)

  const ai = deps.ai
  if (!ai) return end(error('voice_failed'), 'failed', 'config')
  const add = async (units: number) => {
    line.neurons += units
    await addUnits(env.DB, now, units)
  }

  // h. speech to text; its units are counted right after the call, whatever comes next
  const t0 = Date.now()
  const stt = await speechToText(ai, pcm, deps.sttLimitMs)
  line.ms_stt = Date.now() - t0
  await add(stt.units)
  if (stt.kind === 'failed') return end(error('voice_failed'), 'failed', 'stt')
  if (stt.kind === 'silent') return end(error('not_heard'), 'not_heard', 'stt')

  // i. the rewrite (job B's spokenChange): the four fields and nothing else; each call's units counted as it ends
  const counted = countedAi(ai, add)
  const t1 = Date.now()
  const r = await spokenChange({ name: item.name, summary: item.summary, current, heard: stt.heard }, counted.run, {
    timeoutMs: deps.llmLimitMs,
  })
  await counted.settle()
  line.ms_llm = Date.now() - t1
  line.tries = r.tries
  if (!r.ok) return end(error('voice_failed'), 'failed', 'llm')

  // j. store: ONE conditional statement; no row changed = the item was handled meanwhile
  if (!(await storeSpoken(env.DB, owner, item.id, r.draft, now))) return refuse('already_handled', 'store')

  // k. the new reply and its rev, nothing else
  return end(json({ draft: r.draft, rev: await revOf(r.draft) }), 'draft', 'done')
}
