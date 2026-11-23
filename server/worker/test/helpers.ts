import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { base64url } from '../src/crypto'
import type { Deps, Env } from '../src/env'
import { handle } from '../src/app'

export const BASE = 'https://brief.appfinishers.com'

/** A fake clock, in Unix seconds; tests move it forward. */
export const clock = { t: 1_795_000_000 }

/** Records every asset request; answers like the assets binding would, from a tiny fake dist/. */
export const assetCalls: string[] = []
export const fakeAssets = {
  fetch: async (input: RequestInfo | URL) => {
    const u = new URL(input instanceof Request ? input.url : String(input))
    assetCalls.push(u.pathname)
    if (u.pathname === '/index.html')
      return new Response('<!doctype html><title>Brief</title>', { headers: { 'content-type': 'text/html' } })
    if (u.pathname === '/assets/app.js')
      return new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } })
    return new Response(null, { status: 404 })
  },
  connect: () => {
    throw new Error('no')
  },
} as unknown as Fetcher

export function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as Env), ASSETS: fakeAssets, ...overrides }
}

export type FetchStub = (input: string, init?: RequestInit) => Promise<Response>

export const noFetch: FetchStub = async () => {
  throw new Error('unexpected upstream call')
}

export async function call(
  request: Request,
  opts: { env?: Env; fetch?: FetchStub } = {},
): Promise<Response> {
  const deps: Deps = { fetch: opts.fetch ?? noFetch, now: () => clock.t }
  const ctx = createExecutionContext()
  const res = await handle(request, opts.env ?? testEnv(), ctx, deps)
  await waitOnExecutionContext(ctx)
  return res
}

export function req(
  path: string,
  init: { method?: string; body?: string; token?: string; ip?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { 'cf-connecting-ip': init.ip ?? '203.0.113.7', ...init.headers }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return new Request(BASE + path, { method: init.method ?? 'GET', headers, body: init.body })
}

export async function demoSession(ip = '203.0.113.7'): Promise<string> {
  const res = await call(req('/api/session', { method: 'POST', body: '{"mode":"demo"}', ip }))
  if (res.status !== 200) throw new Error(`session ${res.status}`)
  return ((await res.json()) as { session: string }).session
}

/** The id_token shape Google's token endpoint returns (the Worker reads its payload; signature unchecked). */
export function fakeIdToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => base64url(new TextEncoder().encode(JSON.stringify(o)))
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.${part('sig')}`
}

export const ALLOWED = 'allowed.demo@example.com'
export const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
export const FAKE_REFRESH = '1//fake-refresh-token-for-tests-only'

/** A stub of Google's token endpoint answering for `email`; records the calls. */
export function googleStub(email: string, extra: Record<string, unknown> = {}) {
  const calls: { url: string; body: string }[] = []
  const fetch: FetchStub = async (url, init) => {
    calls.push({ url, body: String(init?.body ?? '') })
    return Response.json({
      access_token: 'fake-access-token',
      expires_in: 3599,
      refresh_token: FAKE_REFRESH,
      scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
      token_type: 'Bearer',
      id_token: fakeIdToken({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        exp: clock.t + 3600,
        email,
        email_verified: true,
      }),
      ...extra,
    })
  }
  return { fetch, calls }
}

/** Runs /oauth/start and returns the state Google would echo back. */
export async function startState(ip = '198.51.100.9'): Promise<string> {
  const res = await call(req('/oauth/start', { ip }))
  if (res.status !== 302) throw new Error(`start ${res.status}`)
  return new URL(res.headers.get('location')!).searchParams.get('state')!
}

/** The 6-digit code shown on a callback page. */
export function codeOf(page: string): string {
  const m = /class="code">(\d{6})</.exec(page)
  if (!m) throw new Error('no code on the page')
  return m[1]!
}
