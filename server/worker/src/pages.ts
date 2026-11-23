// The browser pages of the Google sign-in (contract § 3.6). No script; one nonce-tagged <style>; every value escaped.
import { newNonce } from './crypto.ts'
import { esc, html } from './http.ts'

function page(title: string, bodyHtml: string, status: number): Response {
  const nonce = newNonce()
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#555;--accent:#0b57d0}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#aaa;--accent:#8ab4f8}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:17px/1.5 system-ui,sans-serif}
main{max-width:28rem;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 .75rem}
p{margin:.5rem 0}
.muted{color:var(--muted);font-size:.9rem}
.btn{display:inline-block;margin-top:1rem;padding:.75rem 1.1rem;border-radius:8px;background:var(--accent);color:var(--bg);text-decoration:none;font-weight:600}
.code{font:700 2.6rem/1.2 ui-monospace,monospace;letter-spacing:.3rem;margin:1rem 0}
</style>
</head>
<body><main>
${bodyHtml}
</main></body>
</html>`
  return html(doc, status, nonce)
}

export function connectPage(): Response {
  return page(
    'Brief: connect',
    `<h1>Brief</h1>
<p>Brief shows the mail that needs you on Even Realities G2 glasses, with a reply ready to send.</p>
<p>Sign in once here, then type the 6-digit code in the Brief app.</p>
<a class="btn" href="/oauth/start">Sign in with Google</a>
<p class="muted">Brief is built and run by AI agents. Sign-in is open to invited accounts only for now.</p>`,
    200,
  )
}

export function codePage(code: string): Response {
  return page(
    'Brief: your code',
    `<h1>Your code</h1>
<p class="code">${esc(code)}</p>
<p>Type it in the Brief app. It works once, for 10 minutes.</p>`,
    200,
  )
}

export function notOpenPage(): Response {
  return page(
    'Brief: not open yet',
    `<h1>Not open yet</h1>
<p>Brief is not open to this account yet. Nothing from it was kept.</p>`,
    403,
  )
}

export function badRequestPage(): Response {
  return page(
    'Brief: link expired',
    `<h1>This sign-in link is no longer valid</h1>
<p>It was already used, it expired, or it was cancelled.</p>
<a class="btn" href="/connect">Start again</a>`,
    400,
  )
}

export function tooManyPage(retryAfter: number): Response {
  const res = page('Brief: try later', `<h1>Too many tries</h1><p>Please try again in a few minutes.</p>`, 429)
  res.headers.set('retry-after', String(Math.max(1, Math.ceil(retryAfter))))
  return res
}

export function errorPage(): Response {
  return page('Brief: error', `<h1>Something went wrong</h1><p>Please try again later.</p>`, 500)
}

export function notFoundPage(): Response {
  return page('Brief: not found', `<h1>Not found</h1>`, 404)
}
