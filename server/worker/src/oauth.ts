// Google sign-in → refresh token stored encrypted → 6-digit pairing code (contract § 3.6, BRIEF-D2 § 6.3).
// Endpoints and parameters from developers.google.com/identity/protocols/oauth2/web-server (read 2026-11-23).
import { CODE_TTL } from './api.ts'
import { newPairCode, newToken, seal, sha256hex, tokenKey, TOKEN_RE } from './crypto.ts'
import { type Deps, type Env, requireConfig } from './env.ts'
import { addressKey, hit, HOUR, purge } from './limits.ts'
import { badRequestPage, codePage, notOpenPage, tooManyPage } from './pages.ts'

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
]
export const STATE_TTL = 600

/** The lower-cased e-mail list of the secret ALLOWED_ACCOUNTS. */
export function allowedAccounts(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_ACCOUNTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  )
}

// GET /oauth/start → 302 to Google with a fresh single-use state
export async function oauthStart(request: Request, env: Env, deps: Deps, ctx: ExecutionContext): Promise<Response> {
  requireConfig(env, ['GOOGLE_CLIENT_ID', 'OAUTH_REDIRECT_URI'])
  const now = deps.now()
  // not in the contract: a cap so nobody fills the states table (30 per address per hour)
  const refused = await hit(env.DB, now, [
    { key: `oauth:addr:${await addressKey(request)}`, max: 30, windowEnd: now + HOUR, code: 'rate_limited' },
  ])
  if (refused) return tooManyPage(refused.retryAfter)
  const state = newToken()
  await env.DB.prepare('INSERT INTO oauth_states (state_hash, expires_at) VALUES (?1, ?2)')
    .bind(await sha256hex(`state:${state}`), now + STATE_TTL)
    .run()
  ctx.waitUntil(purge(env.DB, now).catch(() => {}))
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.OAUTH_REDIRECT_URI!,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return new Response(null, {
    status: 302,
    headers: { location: `${AUTH_ENDPOINT}?${q}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })
}

interface IdClaims {
  iss?: unknown
  aud?: unknown
  exp?: unknown
  email?: unknown
  email_verified?: unknown
}

/** The payload of the id_token Google's token endpoint returned to us directly over TLS (no signature check). */
function idClaims(idToken: unknown): IdClaims | null {
  if (typeof idToken !== 'string') return null
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  try {
    const b = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4))
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return typeof v === 'object' && v !== null ? (v as IdClaims) : null
  } catch {
    return null
  }
}

/** Thrown for any upstream trouble: the page says « something went wrong », the log says the route and 500. */
export class UpstreamError extends Error {}

// GET /oauth/callback?state=…&code=… (or &error=…)
export async function oauthCallback(request: Request, env: Env, deps: Deps): Promise<Response> {
  requireConfig(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_URI', 'TOKEN_KEY', 'ALLOWED_ACCOUNTS'])
  const now = deps.now()
  const url = new URL(request.url)
  const state = url.searchParams.get('state') ?? ''
  if (!TOKEN_RE.test(state)) return badRequestPage()
  // single use: ONE conditional update; a second callback with the same state finds used_at set
  const used = await env.DB.prepare(
    'UPDATE oauth_states SET used_at = ?2 WHERE state_hash = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING 1 AS ok',
  )
    .bind(await sha256hex(`state:${state}`), now)
    .first()
  if (!used) return badRequestPage()
  const code = url.searchParams.get('code')
  if (url.searchParams.has('error') || !code || code.length > 2048) return badRequestPage()

  const res = await deps.fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: env.OAUTH_REDIRECT_URI!,
      grant_type: 'authorization_code',
    }).toString(),
  })
  if (!res.ok) throw new UpstreamError(`token endpoint ${res.status}`)
  let tok: Record<string, unknown>
  try {
    tok = (await res.json()) as Record<string, unknown>
  } catch {
    throw new UpstreamError('token endpoint: not JSON')
  }
  const claims = idClaims(tok.id_token)
  if (!claims) throw new UpstreamError('no id_token')
  const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com'
  const expOk = typeof claims.exp === 'number' && claims.exp > now
  if (!issOk || claims.aud !== env.GOOGLE_CLIENT_ID || !expOk) throw new UpstreamError('id_token claims')
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''

  // the allow-list is checked BEFORE anything is stored; any other account's tokens are dropped here, unread
  if (!email || claims.email_verified !== true || !allowedAccounts(env).has(email)) return notOpenPage()

  const refresh = tok.refresh_token
  if (typeof refresh !== 'string' || refresh.length === 0) throw new UpstreamError('no refresh_token')
  const scope = typeof tok.scope === 'string' ? tok.scope.slice(0, 1000) : ''
  const emailHash = await sha256hex(`email:${email}`)
  const sealed = await seal(await tokenKey(env.TOKEN_KEY!), refresh, emailHash)
  const account = await env.DB.prepare(
    `INSERT INTO accounts (email_hash, refresh_iv, refresh_ct, scope, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT (email_hash) DO UPDATE SET refresh_iv = ?2, refresh_ct = ?3, scope = ?4, updated_at = ?5
     RETURNING id`,
  )
    .bind(emailHash, sealed.iv, sealed.ct, scope, now)
    .first<{ id: number }>()
  if (!account) throw new Error('account upsert returned nothing')

  // a fresh 6-digit code; a live code with the same digits is never overwritten (retry with other digits)
  for (let i = 0; i < 8; i++) {
    const pair = newPairCode()
    const row = await env.DB.prepare(
      `INSERT INTO pair_codes (code_hash, account_id, expires_at, used_at) VALUES (?1, ?2, ?3, NULL)
       ON CONFLICT (code_hash) DO UPDATE SET account_id = ?2, expires_at = ?3, used_at = NULL
       WHERE pair_codes.expires_at <= ?4 OR pair_codes.used_at IS NOT NULL
       RETURNING 1 AS ok`,
    )
      .bind(await sha256hex(`code:${pair}`), account.id, now + CODE_TTL, now)
      .first()
    if (row) return codePage(pair)
  }
  throw new Error('no free pairing code')
}

