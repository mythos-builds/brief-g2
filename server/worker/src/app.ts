// The router of the `brief` Worker: /app/* static app, /api/* JSON, /connect + /oauth/* sign-in pages, /healthz (BRIEF-D2 § 3).
import { getCalendar, getItems, postLogout, postPairClaim, postSend, postSession, postSkip } from './api.ts'
import { type Deps, type Env, MissingConfig } from './env.ts'
import { error, json, log, withAppHeaders } from './http.ts'
import { oauthCallback, oauthStart } from './oauth.ts'
import { connectPage, errorPage, notFoundPage } from './pages.ts'

export const DEV_ORIGIN = 'http://127.0.0.1:5173'

interface Route {
  name: string
  api: boolean
  run: () => Promise<Response> | Response
}

function route(request: Request, env: Env, ctx: ExecutionContext, deps: Deps): Route {
  const url = new URL(request.url)
  const p = url.pathname
  const m = request.method
  const get = m === 'GET' || m === 'HEAD'

  if (p.startsWith('/api/')) {
    const r = (name: string, run: () => Promise<Response>): Route => ({ name, api: true, run })
    if (p === '/api/session' && m === 'POST') return r('api.session', () => postSession(request, env, deps, ctx))
    if (p === '/api/session/logout' && m === 'POST') return r('api.session.logout', () => postLogout(request, env, deps))
    if (p === '/api/pair/claim' && m === 'POST') return r('api.pair.claim', () => postPairClaim(request, env, deps))
    if (p === '/api/items' && m === 'GET') return r('api.items', () => getItems(request, env, deps))
    if (p === '/api/calendar' && m === 'GET') return r('api.calendar', () => getCalendar(request, env, deps))
    const im = /^\/api\/items\/([^/]+)\/(send|skip)$/.exec(p)
    if (im && m === 'POST') {
      const id = im[1]! // not decoded: ids are URL-safe (ID_RE), anything else is not_found
      return im[2] === 'send'
        ? r('api.items.send', () => postSend(request, env, deps, id))
        : r('api.items.skip', () => postSkip(request, env, deps, id))
    }
    return { name: 'api.unknown', api: true, run: () => error('not_found') }
  }
  if (p === '/healthz' && get) return { name: 'healthz', api: true, run: () => json({ ok: true }) }
  if (p === '/' && get) return { name: 'root', api: false, run: () => redirect('/app/') }
  if (p === '/connect' && get) return { name: 'connect', api: false, run: () => connectPage() }
  if (p === '/oauth/start' && get) return { name: 'oauth.start', api: false, run: () => oauthStart(request, env, deps, ctx) }
  if (p === '/oauth/callback' && get) return { name: 'oauth.callback', api: false, run: () => oauthCallback(request, env, deps) }
  if (p === '/app' && get) return { name: 'app', api: false, run: () => redirect('/app/') }
  if (p.startsWith('/app/') && get) return { name: 'app', api: false, run: () => serveApp(request, env, url) }
  return { name: 'unknown', api: false, run: () => notFoundPage() }
}

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } })
}

/** /app/ = the asset /index.html, /app/<path> = the asset /<path> (job A's dist/, Vite base './'). */
async function serveApp(request: Request, env: Env, url: URL): Promise<Response> {
  const rest = url.pathname.slice('/app/'.length)
  const target = new URL(rest === '' ? '/index.html' : `/${rest}`, url.origin)
  const res = await env.ASSETS.fetch(new Request(target, { method: request.method, headers: request.headers }))
  return withAppHeaders(res)
}

function corsHeaders(request: Request, env: Env): Record<string, string> | null {
  if (env.ENV !== 'dev' || request.headers.get('origin') !== DEV_ORIGIN) return null
  return {
    'access-control-allow-origin': DEV_ORIGIN,
    'access-control-allow-methods': 'GET, POST',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext, deps: Deps): Promise<Response> {
  const cors = corsHeaders(request, env)
  if (request.method === 'OPTIONS') {
    const isApi = new URL(request.url).pathname.startsWith('/api/')
    log('preflight', cors && isApi ? 204 : 404)
    return cors && isApi ? new Response(null, { status: 204, headers: cors }) : error('not_found')
  }
  const r = route(request, env, ctx, deps)
  let res: Response
  try {
    res = await r.run()
    log(r.name, res.status)
  } catch (e) {
    // never a message, a stack or an upstream body in the answer; the log gets the route, 500, and a missing NAME
    log(r.name, 500, e instanceof MissingConfig ? { missing: e.names.join(',') } : {})
    res = r.api ? error('server_error') : errorPage()
  }
  if (cors && r.api) {
    res = new Response(res.body, res)
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
  }
  return res
}
