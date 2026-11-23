// Every Google call the Worker may ever make (BRIEF-D3 § 1.3) and no other: the token endpoint (code exchange and
// refresh), the revoke endpoint, users.labels.list, users.messages.list on the label's id, users.messages.get for an
// id that list returned, Calendar events.list on `primary`. Each goes through deps.fetch; the sync's calls are counted
// against the run's cap (RunCap). No search, no other label, no other mailbox call, no write.
//
// Sources (read 2026-11-23):
// - developers.google.com/identity/protocols/oauth2/web-server: « To refresh an access token, your application sends an
//   HTTPS POST request to Google's authorization server (https://oauth2.googleapis.com/token) » with client_id,
//   client_secret, grant_type « must be set to refresh_token », refresh_token; « A successful exchange is indicated by
//   a 200 OK response containing a new access token » (access_token, expires_in, scope, token_type). Revoke: « your
//   application makes a request to https://oauth2.googleapis.com/revoke and includes the token as a parameter »,
//   Content-type application/x-www-form-urlencoded; « If the revocation is successfully processed, then the HTTP status
//   code of the response is 200 ». A refresh token that « may have expired or has been invalidated » → invalid_grant.
// - gmail/api/reference/rest/v1/users.labels/list: « GET https://gmail.googleapis.com/gmail/v1/users/{userId}/labels »,
//   each label « only contains an id, name, messageListVisibility, labelListVisibility, and type ».
// - users.messages/list: « GET https://gmail.googleapis.com/gmail/v1/users/{userId}/messages », labelIds « Only return
//   messages with labels that match all of the specified label IDs », maxResults (default 100, max 500); messages[]
//   « contains only an id and a threadId ».
// - users.messages/get: « GET https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id} », userId « The
//   special value me can be used to indicate the authenticated user », format « The format to return the message in ».
// - calendar/api/v3/reference/events/list: « GET https://www.googleapis.com/calendar/v3/calendars/calendarId/events »,
//   « use the "primary" keyword », timeMin « Lower bound (exclusive) for an event's end time », timeMax « Upper bound
//   (exclusive) for an event's start time », singleEvents, orderBy « startTime », maxResults.
import type { Deps, Env } from './env.ts'

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const GMAIL_BASE = 'https://gmail.googleapis.com'
export const CALENDAR_BASE = 'https://www.googleapis.com'

export interface Upstreams {
  tokenUrl: string
  revokeUrl: string
  gmailBase: string
  calendarBase: string
  /** The model API's base for triage's `baseUrl` option; undefined = the provider's real one. */
  modelBase: string | undefined
}

/** A dev base address: an http(s) URL without query or fragment, trailing slash removed; anything else is ignored. */
function devUrl(v: string | undefined): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined
  try {
    const u = new URL(v.trim())
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.search || u.hash) return undefined
    return u.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

/** The five dev vars (BRIEF-D3 § 3.8) are honoured ONLY when ENV is "dev"; in any other ENV the real constants. */
export function upstreams(env: Env): Upstreams {
  const real: Upstreams = {
    tokenUrl: GOOGLE_TOKEN_URL,
    revokeUrl: GOOGLE_REVOKE_URL,
    gmailBase: GMAIL_BASE,
    calendarBase: CALENDAR_BASE,
    modelBase: undefined,
  }
  if (env.ENV !== 'dev') return real
  return {
    tokenUrl: devUrl(env.GOOGLE_TOKEN_URL) ?? real.tokenUrl,
    revokeUrl: devUrl(env.GOOGLE_REVOKE_URL) ?? real.revokeUrl,
    gmailBase: devUrl(env.GMAIL_BASE) ?? real.gmailBase,
    calendarBase: devUrl(env.CALENDAR_BASE) ?? real.calendarBase,
    modelBase: devUrl(env.MODEL_BASE),
  }
}

/** The run's cap of outgoing requests (BRIEF-D3 § 3.5: 40). take() before every request; at the cap it throws. */
export class RunCapReached extends Error {
  constructor() {
    super('run request cap reached')
  }
}

export class RunCap {
  used = 0
  constructor(readonly max = 40) {}
  /** Reserves one request or throws RunCapReached. */
  take(): void {
    if (this.used >= this.max) throw new RunCapReached()
    this.used += 1
  }
  /** Reserves one request; false at the cap (for the model budget, which must answer, not throw). */
  tryTake(): boolean {
    if (this.used >= this.max) return false
    this.used += 1
    return true
  }
}

/** A Google answer that is not 2xx: the step and the status only, never a body. */
export class GoogleError extends Error {
  constructor(
    readonly step: string,
    readonly status: number,
  ) {
    super(`${step} ${status}`)
  }
}

/** The token endpoint answered invalid_grant: the grant is dead until a new sign-in. */
export class InvalidGrant extends Error {
  constructor() {
    super('invalid_grant')
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

async function readJson(res: Response, step: string): Promise<Record<string, unknown>> {
  let v: unknown
  try {
    v = await res.json()
  } catch {
    throw new GoogleError(step, res.status)
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new GoogleError(step, res.status)
  return v as Record<string, unknown>
}

/** grant_type=refresh_token → a new access token and its lifetime (seconds). */
export async function refreshAccessToken(
  deps: Deps,
  up: Upstreams,
  cap: RunCap,
  client: { id: string; secret: string },
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  cap.take()
  const res = await deps.fetch(up.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.id,
      client_secret: client.secret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  })
  if (!res.ok) {
    let code = ''
    try {
      const body = (await res.json()) as { error?: unknown }
      code = typeof body.error === 'string' ? body.error : ''
    } catch {
      // not JSON: an ordinary upstream error
    }
    if (res.status === 400 && code === 'invalid_grant') throw new InvalidGrant()
    throw new GoogleError('token.refresh', res.status)
  }
  const body = await readJson(res, 'token.refresh')
  const token = body.access_token
  const expiresIn = Number(body.expires_in)
  if (typeof token !== 'string' || token === '' || !Number.isFinite(expiresIn)) throw new GoogleError('token.refresh', 200)
  return { accessToken: token, expiresIn: Math.max(0, Math.floor(expiresIn)) }
}

/** Revokes a token at Google, best effort: one request, never throws, never logged. */
export async function revokeToken(deps: Deps, up: Upstreams, token: string): Promise<void> {
  try {
    const res = await deps.fetch(up.revokeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    })
    await res.body?.cancel()
  } catch {
    // best effort: the tokens were never stored either way
  }
}

export interface RawEvent {
  id?: unknown
  status?: unknown
  summary?: unknown
  start?: { dateTime?: unknown; date?: unknown }
  creator?: { self?: unknown }
  organizer?: { self?: unknown }
  attendees?: Array<{ email?: unknown; self?: unknown }>
  eventType?: unknown
}

/** The read-only Gmail and Calendar calls of one account, with that account's access token. */
export class GoogleClient {
  /** Ids that users.messages.list returned in this run: the only ids users.messages.get may ask for. */
  private listed = new Set<string>()

  constructor(
    private readonly deps: Deps,
    private readonly up: Upstreams,
    private readonly cap: RunCap,
    private readonly accessToken: string,
  ) {}

  private async get(step: string, url: string): Promise<Record<string, unknown>> {
    this.cap.take()
    const res = await this.deps.fetch(url, { method: 'GET', headers: { authorization: `Bearer ${this.accessToken}` } })
    if (!res.ok) {
      await res.body?.cancel()
      throw new GoogleError(step, res.status)
    }
    return readJson(res, step)
  }

  /** users.labels.list → [{id, name}]. */
  async labels(): Promise<Array<{ id: string; name: string }>> {
    const body = await this.get('gmail.labels', `${this.up.gmailBase}/gmail/v1/users/me/labels`)
    const out: Array<{ id: string; name: string }> = []
    if (Array.isArray(body.labels))
      for (const l of body.labels as Array<{ id?: unknown; name?: unknown }>)
        if (typeof l?.id === 'string' && typeof l.name === 'string') out.push({ id: l.id, name: l.name })
    return out
  }

  /** users.messages.list with labelIds = the label's id, maxResults 20 → the ids, newest first as Google lists them. */
  async messageIds(labelId: string): Promise<string[]> {
    const q = new URLSearchParams({ labelIds: labelId, maxResults: '20' })
    const body = await this.get('gmail.list', `${this.up.gmailBase}/gmail/v1/users/me/messages?${q}`)
    const ids: string[] = []
    if (Array.isArray(body.messages))
      for (const m of body.messages as Array<{ id?: unknown }>)
        if (typeof m?.id === 'string' && SAFE_ID.test(m.id) && !ids.includes(m.id)) ids.push(m.id)
    const top = ids.slice(0, 20)
    for (const id of top) this.listed.add(id)
    return top
  }

  /** users.messages.get format=full, for an id that messageIds() returned in this run only. */
  async message(id: string): Promise<unknown> {
    if (!this.listed.has(id)) throw new Error('message id not listed in this run')
    const q = new URLSearchParams({ format: 'full' })
    return this.get('gmail.get', `${this.up.gmailBase}/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${q}`)
  }

  /** Calendar events.list on primary: from `from` to `to` (Unix seconds), single events by start time, 5 at most. */
  async events(from: number, to: number): Promise<RawEvent[]> {
    const q = new URLSearchParams({
      timeMin: new Date(from * 1000).toISOString(),
      timeMax: new Date(to * 1000).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '5',
    })
    const body = await this.get('calendar.list', `${this.up.calendarBase}/calendar/v3/calendars/primary/events?${q}`)
    return Array.isArray(body.items) ? (body.items as RawEvent[]).slice(0, 5) : []
  }
}
