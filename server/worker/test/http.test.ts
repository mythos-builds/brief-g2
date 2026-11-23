import { describe, expect, it, vi } from 'vitest'
import { esc } from '../src/http'
import { assetCalls, call, req, testEnv } from './helpers'

const DEV = 'http://127.0.0.1:5173'

describe('static app and plain routes', () => {
  it('GET /healthz → 200 {"ok":true} as no-store JSON', async () => {
    const res = await call(req('/healthz'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('{"ok":true}')
  })

  it('GET / → 302 /app/ and GET /app → 302 /app/ (the app uses relative asset URLs)', async () => {
    for (const p of ['/', '/app']) {
      const res = await call(req(p))
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/app/')
    }
  })

  it('/app/ serves the asset /index.html and /app/<path> the asset <path>, with the app CSP', async () => {
    assetCalls.length = 0
    const page = await call(req('/app/'))
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>Brief</title>')
    const js = await call(req('/app/assets/app.js'))
    expect(js.status).toBe(200)
    expect(assetCalls).toEqual(['/index.html', '/assets/app.js'])
    for (const res of [page, js]) {
      const csp = res.headers.get('content-security-policy')!
      expect(csp).toContain("script-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).not.toContain('unsafe-inline')
      expect(csp).not.toContain('unsafe-eval')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
    }
    expect((await call(req('/app/missing.png'))).status).toBe(404)
  })

  it('nothing outside /app/ reaches the assets (no /index.html, no /assets/… at the root)', async () => {
    assetCalls.length = 0
    expect((await call(req('/index.html'))).status).toBe(404)
    expect((await call(req('/assets/app.js'))).status).toBe(404)
    expect(assetCalls).toEqual([])
  })

  it('an unknown /api route → 404 {"error":"not_found"}; a wrong method too', async () => {
    for (const r of [req('/api/nope'), req('/api/session'), req('/api/items', { method: 'POST', body: '{}' })]) {
      const res = await call(r)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('{"error":"not_found"}')
    }
  })

  it('a crash answers {"error":"server_error"} with no message or stack, and logs the route and 500 only', async () => {
    const broken = {
      prepare: () => {
        throw new Error('SQLITE internal detail with secrets')
      },
      batch: () => Promise.reject(new Error('SQLITE internal detail with secrets')),
    } as unknown as D1Database
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => void logs.push(s))
    const res = await call(req('/api/session', { method: 'POST', body: '{"mode":"demo"}' }), { env: testEnv({ DB: broken }) })
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('{"error":"server_error"}')
    expect(logs).toEqual([JSON.stringify({ route: 'api.session', status: 500 })])
  })
})

describe('CORS', () => {
  it('none in production, even for the dev origin', async () => {
    const res = await call(req('/healthz', { headers: { origin: DEV } }))
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    const pre = await call(req('/api/items', { method: 'OPTIONS', headers: { origin: DEV } }))
    expect(pre.status).toBe(404)
    expect(pre.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('with ENV=dev: exactly http://127.0.0.1:5173, GET and POST, authorization + content-type', async () => {
    const e = testEnv({ ENV: 'dev' })
    const pre = await call(req('/api/items', { method: 'OPTIONS', headers: { origin: DEV } }), { env: e })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe(DEV)
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, POST')
    expect(pre.headers.get('access-control-allow-headers')).toBe('authorization, content-type')
    const res = await call(req('/api/items', { headers: { origin: DEV } }), { env: e })
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe(DEV)
    for (const other of ['http://localhost:5173', 'http://127.0.0.1:5174', 'https://evil.example.com', 'null']) {
      const r = await call(req('/api/items', { headers: { origin: other } }), { env: e })
      expect(r.headers.get('access-control-allow-origin')).toBeNull()
    }
  })
})

describe('escaping', () => {
  it('esc() neutralises markup and attribute breakers', () => {
    expect(esc(`<script>"x'</script>`)).not.toMatch(/[<>"']/)
  })

  it('a 404 page never echoes the path', async () => {
    const res = await call(req('/%3Cscript%3Ealert(1)%3C/script%3E'))
    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).not.toContain('<script>')
    expect(body).not.toContain('alert')
  })
})

describe('entry module', () => {
  it('exports only the default handler (workerd treats every named export of main as an entrypoint)', async () => {
    const mod = await import('../src/index')
    expect(Object.keys(mod)).toEqual(['default'])
    expect(typeof mod.default.fetch).toBe('function')
  })
})
