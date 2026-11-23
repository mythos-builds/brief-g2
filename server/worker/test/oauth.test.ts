import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { open, sha256hex, tokenKey } from '../src/crypto'
import { AUTH_ENDPOINT, SCOPES, TOKEN_ENDPOINT } from '../src/oauth'
import { ALLOWED, call, CLIENT_ID, clock, codeOf, FAKE_REFRESH, type FetchStub, googleStub, req, startState, testEnv } from './helpers'

const REDIRECT = 'https://brief.appfinishers.com/oauth/callback'

beforeEach(() => {
  clock.t = 1_795_000_000
})

const callback = (qs: string, fetch?: FetchStub, e = testEnv()) =>
  call(req(`/oauth/callback?${qs}`, { ip: '198.51.100.9' }), { fetch, env: e })

describe('GET /connect', () => {
  it('is a phone page with one « Sign in with Google » link to /oauth/start, strict CSP, no script', async () => {
    const res = await call(req('/connect'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('unsafe-inline')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    const page = await res.text()
    expect(page).toContain('<a class="btn" href="/oauth/start">Sign in with Google</a>')
    expect(page).not.toMatch(/<script/i)
    const nonce = /style-src 'nonce-([^']+)'/.exec(csp)![1]
    expect(page).toContain(`<style nonce="${nonce}">`)
  })
})

describe('GET /oauth/start', () => {
  it('redirects to Google with the fixed redirect_uri, the five scopes, offline + consent, and a stored single-use state', async () => {
    const res = await call(req('/oauth/start'))
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location')!)
    expect(`${loc.origin}${loc.pathname}`).toBe(AUTH_ENDPOINT)
    const q = loc.searchParams
    expect(q.get('client_id')).toBe(CLIENT_ID)
    expect(q.get('redirect_uri')).toBe(REDIRECT)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')!.split(' ')).toEqual(SCOPES)
    expect(SCOPES).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.readonly',
    ])
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('prompt')).toBe('consent')
    const state = q.get('state')!
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const row = await env.DB.prepare('SELECT * FROM oauth_states').first<{ state_hash: string; expires_at: number }>()
    expect(row!.state_hash).toBe(await sha256hex(`state:${state}`))
    expect(row!.expires_at).toBe(clock.t + 600)
  })

  it('takes the redirect_uri from the var', async () => {
    const res = await call(req('/oauth/start'), { env: testEnv({ OAUTH_REDIRECT_URI: 'https://elsewhere.example.com/cb' }) })
    expect(new URL(res.headers.get('location')!).searchParams.get('redirect_uri')).toBe('https://elsewhere.example.com/cb')
  })

  it('fails with a 500 page, and the NAME of the missing secret in the log only, when the client id is absent', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s))
    const res = await call(req('/oauth/start'), { env: testEnv({ GOOGLE_CLIENT_ID: undefined }) })
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('GOOGLE_CLIENT_ID')
    expect(logs).toEqual([JSON.stringify({ route: 'oauth.start', status: 500, missing: 'GOOGLE_CLIENT_ID' })])
  })
})

describe('GET /oauth/callback', () => {
  it('success: exchanges the code, stores the refresh token AES-256-GCM encrypted, shows a 6-digit code that pairs', async () => {
    const state = await startState()
    const g = googleStub('Allowed.Demo@Example.com')
    const res = await callback(`state=${state}&code=fake-auth-code`, g.fetch)
    expect(res.status).toBe(200)
    const page = await res.text()
    expect(page).toContain('Type it in the Brief app')
    expect(page).not.toContain(FAKE_REFRESH)
    expect(page).not.toContain('fake-access-token')
    expect(page.toLowerCase()).not.toContain(ALLOWED)

    // the token request, as Google's page lists it
    expect(g.calls).toHaveLength(1)
    expect(g.calls[0]!.url).toBe(TOKEN_ENDPOINT)
    const sent = new URLSearchParams(g.calls[0]!.body)
    expect(Object.fromEntries(sent)).toEqual({
      code: 'fake-auth-code',
      client_id: CLIENT_ID,
      client_secret: 'test-client-secret-not-real',
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    })

    // stored: e-mail hash only, refresh token encrypted with a 12-byte IV, decryptable with TOKEN_KEY only
    const acc = await env.DB.prepare('SELECT * FROM accounts').first<{ email_hash: string; refresh_iv: string; refresh_ct: string }>()
    expect(JSON.stringify(acc)).not.toContain(FAKE_REFRESH)
    expect(JSON.stringify(acc).toLowerCase()).not.toContain('allowed.demo')
    expect(acc!.email_hash).toBe(await sha256hex(`email:${ALLOWED}`))
    expect(atob(acc!.refresh_iv).length).toBe(12)
    const key = await tokenKey(testEnv().TOKEN_KEY!)
    expect(await open(key, { iv: acc!.refresh_iv, ct: acc!.refresh_ct }, acc!.email_hash)).toBe(FAKE_REFRESH)

    // the code pairs once
    const code = codeOf(page)
    const claim = await call(req('/api/pair/claim', { method: 'POST', body: JSON.stringify({ code }) }))
    expect(claim.status).toBe(200)
    expect(((await claim.json()) as { mode: string }).mode).toBe('paired')
  })

  it('a second sign-in re-encrypts with a fresh IV (one row per account)', async () => {
    await callback(`state=${await startState()}&code=a`, googleStub(ALLOWED).fetch)
    const first = await env.DB.prepare('SELECT refresh_iv FROM accounts').first<{ refresh_iv: string }>()
    await callback(`state=${await startState()}&code=b`, googleStub(ALLOWED).fetch)
    const rows = await env.DB.prepare('SELECT refresh_iv FROM accounts').all<{ refresh_iv: string }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]!.refresh_iv).not.toBe(first!.refresh_iv)
  })

  it('an account outside ALLOWED_ACCOUNTS gets the 403 « not open yet » page and NOTHING is stored', async () => {
    const res = await callback(`state=${await startState()}&code=x`, googleStub('stranger@example.org').fetch)
    expect(res.status).toBe(403)
    const page = await res.text()
    expect(page).toContain('Not open yet')
    expect(page).not.toContain('stranger')
    expect(page).not.toContain(FAKE_REFRESH)
    const n = await env.DB.batch<{ n: number }>(
      ['accounts', 'pair_codes'].map((t) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`)),
    )
    expect(n.map((r) => r.results[0]!.n)).toEqual([0, 0])
  })

  it('an unverified e-mail is refused like an outsider', async () => {
    const g = googleStub(ALLOWED)
    const stub = async (u: string, i?: RequestInit) => {
      const r = (await (await g.fetch(u, i)).json()) as Record<string, string>
      const [h, , s] = r.id_token!.split('.') as [string, string, string]
      const claims = { iss: 'accounts.google.com', aud: CLIENT_ID, exp: clock.t + 60, email: ALLOWED, email_verified: false }
      const p = btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
      return Response.json({ ...r, id_token: `${h}.${p}.${s}` })
    }
    expect((await callback(`state=${await startState()}&code=x`, stub)).status).toBe(403)
  })

  it('a reused state gets the 400 page and no second exchange', async () => {
    const state = await startState()
    const g = googleStub(ALLOWED)
    expect((await callback(`state=${state}&code=x`, g.fetch)).status).toBe(200)
    expect((await callback(`state=${state}&code=x`, g.fetch)).status).toBe(400)
    expect(g.calls).toHaveLength(1)
  })

  it('the same state at the same moment wins once', async () => {
    const state = await startState()
    const g = googleStub(ALLOWED)
    const all = await Promise.all(Array.from({ length: 4 }, () => callback(`state=${state}&code=x`, g.fetch)))
    expect(all.map((r) => r.status).sort()).toEqual([200, 400, 400, 400])
  })

  it.each([
    ['no state', 'code=x'],
    ['a wrong state', `state=${'B'.repeat(43)}&code=x`],
    ['a malformed state', 'state=%3Cscript%3E&code=x'],
  ])('%s → 400 page, no exchange', async (_, qs) => {
    const g = googleStub(ALLOWED)
    const res = await callback(qs, g.fetch)
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('<script>')
    expect(g.calls).toHaveLength(0)
  })

  it('an expired state (10 minutes) → 400', async () => {
    const state = await startState()
    clock.t += 600
    expect((await callback(`state=${state}&code=x`, googleStub(ALLOWED).fetch)).status).toBe(400)
  })

  it('a refusal on Google (error=access_denied) → 400 page, state used, no exchange', async () => {
    const g = googleStub(ALLOWED)
    expect((await callback(`state=${await startState()}&error=access_denied`, g.fetch)).status).toBe(400)
    expect(g.calls).toHaveLength(0)
  })

  it('an upstream failure → the 500 page, never the upstream body, and nothing stored', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s))
    const bad = async () => new Response('{"error":"invalid_grant","secret_detail":"UPSTREAM-BODY"}', { status: 400 })
    const res = await callback(`state=${await startState()}&code=x`, bad)
    spy.mockRestore()
    expect(res.status).toBe(500)
    const page = await res.text()
    expect(page).not.toContain('UPSTREAM-BODY')
    expect(page).not.toContain('invalid_grant')
    expect(logs.join('\n')).not.toContain('UPSTREAM-BODY')
    expect(logs.at(-1)).toBe(JSON.stringify({ route: 'oauth.callback', status: 500 }))
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>())!.n).toBe(0)
  })

  it('an id_token for another client (aud) is refused', async () => {
    const g = googleStub(ALLOWED, {})
    const other = async (u: string, i?: RequestInit) => {
      const r = (await (await g.fetch(u, i)).json()) as Record<string, string>
      const claims = { iss: 'https://accounts.google.com', aud: 'other', exp: clock.t + 60, email: ALLOWED, email_verified: true }
      const p = btoa(JSON.stringify(claims)).replace(/=+$/, '')
      return Response.json({ ...r, id_token: `x.${p}.y` })
    }
    expect((await callback(`state=${await startState()}&code=x`, other)).status).toBe(500)
  })

  it('a bad TOKEN_KEY fails closed: 500, nothing stored', async () => {
    const e = testEnv({ TOKEN_KEY: 'c2hvcnQ=' })
    const state = await startState()
    expect((await callback(`state=${state}&code=x`, googleStub(ALLOWED).fetch, e)).status).toBe(500)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM accounts').first<{ n: number }>())!.n).toBe(0)
  })

  it('never logs the token, the code or the e-mail', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s))
    const state = await startState()
    const res = await callback(`state=${state}&code=fake-auth-code`, googleStub(ALLOWED).fetch)
    const code = codeOf(await res.text())
    const claim = await call(req('/api/pair/claim', { method: 'POST', body: JSON.stringify({ code }) }))
    const { session } = (await claim.json()) as { session: string }
    await call(req('/api/items', { token: session }))
    spy.mockRestore()
    const all = logs.join('\n')
    for (const secret of [state, 'fake-auth-code', code, session, FAKE_REFRESH, ALLOWED, 'allowed.demo']) {
      expect(all.toLowerCase()).not.toContain(secret.toLowerCase())
    }
    for (const line of logs) expect(Object.keys(JSON.parse(line)).sort()).toEqual(['route', 'status'])
  })
})
