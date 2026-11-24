// Answers, headers and the log line. Every JSON answer: the contract's content-type + no-store (BRIEF-D2 § 3).

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_open'
  | 'signin_needed'
  | 'not_found'
  | 'already_handled'
  | 'rate_limited'
  | 'daily_cap'
  | 'server_error'
  | 'send_failed'
  | 'send_unknown'

export const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_open: 403,
  signin_needed: 403,
  not_found: 404,
  already_handled: 409,
  rate_limited: 429,
  daily_cap: 429,
  server_error: 500,
  // BRIEF-D4 § 3.1: a definite failure (nothing left, the item is offered again) · an unknown outcome (it may have left)
  send_failed: 502,
  send_unknown: 504,
}

const COMMON = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

const JSON_CSP = "default-src 'none'; frame-ancestors 'none'"

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...COMMON,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': JSON_CSP,
      ...headers,
    },
  })
}

/** `{"error":"<code>"}` and nothing else; `retryAfter` (seconds) adds the retry-after header. */
export function error(code: ErrorCode, retryAfter?: number): Response {
  const headers: Record<string, string> = {}
  if (retryAfter !== undefined) headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfter)))
  return json({ error: code }, STATUS[code], headers)
}

/** A strict CSP for our own HTML pages: no script at all, one nonce-tagged <style>. */
export function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/**
 * The CSP for the built app (job A's dist/): same-origin script, style, fetch; no inline script; never framed.
 * Both hosts load the app URL as a top-level document (Even app: Flutter WebView; simulator: Tauri WebView), so
 * `frame-ancestors 'none'` does not block them (README, « Framing »).
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export function html(body: string, status: number, nonce: string): Response {
  return new Response(body, {
    status,
    headers: {
      ...COMMON,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': pageCsp(nonce),
      'x-frame-options': 'DENY',
    },
  })
}

/** Adds the security headers to an asset answer (the app). Keeps the asset's own caching headers. */
export function withAppHeaders(res: Response): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(COMMON)) out.headers.set(k, v)
  out.headers.set('content-security-policy', APP_CSP)
  out.headers.set('x-frame-options', 'DENY')
  return out
}

/** The raw body, or null when it is larger than maxBytes (checked on the header AND while reading). */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (!Number.isFinite(declared) || declared > maxBytes) return null
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** A JSON object body of at most maxBytes, or null (too big, not UTF-8, not JSON, not a plain object). */
export async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const raw = await readBodyCapped(request, maxBytes)
  if (!raw) return null
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)
    const v: unknown = JSON.parse(text)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    return v as Record<string, unknown>
  } catch {
    return null
  }
}

/** One JSON line per answer: the route name and the status (and, for a missing secret, its NAME). Nothing else. */
export function log(route: string, status: number, extra: Record<string, string> = {}): void {
  console.log(JSON.stringify({ route, status, ...extra }))
}

/** Escapes text for HTML content and attribute values. Every value put into a page goes through this. */
export function esc(s: string): string {
  return s.replace(/[&<>"'`=/]/g, (c) => `&#${c.charCodeAt(0)};`)
}
