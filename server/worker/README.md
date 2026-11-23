# brief: the Cloudflare Worker

One Worker, `brief`, on `https://brief.appfinishers.com`:

| Path | What |
|---|---|
| `/app/`, `/app/<path>` | the built glasses app (`app/dist/`, job A), served from the `[assets]` binding; `/` and `/app` → 302 `/app/` |
| `/api/session`, `/api/items`, `/api/items/<id>/send`, `/api/items/<id>/skip`, `/api/pair/claim` | JSON, contract in `../../../BRIEF-D2.md` § 3 |
| `/connect`, `/oauth/start`, `/oauth/callback` | the Google sign-in pages → a 6-digit pairing code |
| `/healthz` | `{"ok":true}` |

State: ONE D1 database (`DB`), schema in `migrations/0001_init.sql`. No KV, no Durable Object. Day 2: no model key, no
model call, nothing is ever sent (`send` answers `{"sent":true,"real":false}`); items come from `src/demo-items.json`.

## Files
- `src/index.ts`: the entry, default export only (workerd treats every named export of `main` as an entrypoint).
- `src/app.ts`: router, error handler (never a message or a stack in an answer), dev-only CORS.
- `src/api.ts`: the five `/api` routes. `src/oauth.ts`: Google sign-in. `src/pages.ts`: the HTML pages.
- `src/limits.ts`: rate limits and caps (one atomic `INSERT … ON CONFLICT … RETURNING` per counter, one batch per
  request), lazy purge. `src/crypto.ts`: tokens, SHA-256, codes, AES-256-GCM. `src/http.ts`: headers, CSP, body cap, log.
- `src/items.ts` + `src/demo-items.json`: the frozen demo items and their shape check.
- `test/`: vitest in local workerd + local D1 (`@cloudflare/vitest-plugin`). Google is a stubbed `fetch`; any real
  `fetch` in a test throws.

## Checks
```sh
cd app/server/worker
npm test                      # vitest run
npm run typecheck             # tsc --noEmit
npx wrangler deploy --dry-run # bundles, lists the bindings, uploads nothing (needs app/dist: npm run build in app/)
```

## Deploy (the CEO only; each secret piped from a file, never typed, never echoed)
Run from `app/server/worker`, with the Cloudflare API token in the environment (`CLOUDFLARE_API_TOKEN`).
`S=<your secret folder>` (outside the repo).
1. Build the app that talks to this Worker: `(cd ../.. && VITE_DATA_SOURCE=backend npm run build)`. A plain
   `npm run build` makes the static demo, which never calls `/api/` (D2 review, finding 2). Check before going on:
   `grep -c 'VITE_DATA_SOURCE:.backend.' ../../dist/assets/index-*.js` → `1` (`0` = the static build: redo step 1).
2. Create the database: `npx wrangler d1 create brief`, then paste the printed id over the placeholder
   `database_id = "00000000-…"` in `wrangler.toml`.
3. Schema: `npx wrangler d1 migrations apply brief --remote`.
4. Secrets (stdin from a file or a pipe, nothing on the command line):
   ```sh
   jq -r .web.client_id     "$S/brief-google-oauth-client.json" | npx wrangler secret put GOOGLE_CLIENT_ID
   jq -r .web.client_secret "$S/brief-google-oauth-client.json" | npx wrangler secret put GOOGLE_CLIENT_SECRET
   (umask 077; openssl rand -base64 32 > "$S/brief-token-key")   # once; keep it: losing it = redo the sign-in
   npx wrangler secret put TOKEN_KEY < "$S/brief-token-key"
   npx wrangler secret put ALLOWED_ACCOUNTS < "$S/brief-allowed-accounts"   # one line, comma-separated e-mails
   ```
   The `.web.client_id` path assumes Google's standard « web application » client download: NOT CONFIRMED (the file was
   not read by the builder). Check with `jq 'keys' "$S/brief-google-oauth-client.json"` (prints key names only).
5. In the Google Cloud console, the OAuth client's authorized redirect URI must be exactly
   `https://brief.appfinishers.com/oauth/callback` (the var `OAUTH_REDIRECT_URI`).
6. `npx wrangler deploy --dry-run`, then `npx wrangler deploy` (the `custom_domain` route creates the DNS record).
7. From outside: `curl -s https://brief.appfinishers.com/healthz` → `{"ok":true}` · `/app/` → 200 ·
   `curl -s -X POST https://brief.appfinishers.com/api/session -d '{"mode":"demo"}'` → a session ·
   `GET /api/items` with `Authorization: Bearer <session>` → the 3 items · the deployed app is the backend build:
   `B=https://brief.appfinishers.com/app; curl -s "$B/$(curl -s "$B/" | grep -o 'assets/index-[^"]*\.js')" | grep -c 'VITE_DATA_SOURCE:.backend.'`
   → `1`.

Local run (dummies only): `cp .dev.vars.example .dev.vars` (git-ignored), then
`npx wrangler d1 migrations apply brief --local && npm run dev` → `http://127.0.0.1:8787` (ENV=dev: CORS for
`http://127.0.0.1:5173` only).

## Security choices
- Tokens: 32 random bytes, base64url (43 chars); only their SHA-256 is stored; read only from `Authorization: Bearer`.
  OAuth states and pairing codes are stored as SHA-256 too; e-mails as SHA-256 only (`accounts.email_hash`).
- Refresh token: AES-256-GCM, a fresh 12-byte IV per record, the e-mail hash as additional data, key = `TOKEN_KEY`.
  The allow-list is checked on the verified e-mail of the `id_token` BEFORE anything is written; any other account
  gets the 403 page and its tokens are dropped (not stored, not revoked: revoking would be one more call to Google).
- The `id_token` comes straight from Google's token endpoint over TLS; the Worker checks `iss`, `aud`, `exp`,
  `email_verified` but not the signature (OpenID Connect allows this for a token received directly from the token
  endpoint; that page was not read today: NOT CONFIRMED).
- Logs: one JSON line `{"route","status"}` per request (plus the NAME of a missing secret). Never a token, a code, an
  e-mail, an address or an upstream body.
- Headers: `nosniff`, `referrer-policy: no-referrer` everywhere; our pages: `default-src 'none'`, one nonce-tagged
  `<style>`, no script; the app: `script-src 'self'`, no inline script, `connect-src 'self'`; JSON: no-store.
- Limits not in the contract: `/oauth/start` 30 per address per hour (keeps the states table small).

## Framing (why `frame-ancestors 'none'` + `X-Frame-Options: DENY` on the app)
Read in the local Even Hub docs (`upstream/everything-evenhub/plugins/everything-evenhub/skills/`): the Even app runs a
plugin « inside a Flutter WebView hosted by the Even companion app » (`sdk-reference`), and in the background « creates
a new `HeadlessInAppWebView`, loads the same plugin URL » (`background-state`); the simulator is started with the URL
as its argument (`evenhub-simulator http://localhost:5173`) and « hosts a WebView » (`test-with-simulator`); the
installed simulator binary is a Tauri (WebKitGTK) app. Both load the app as a top-level document, neither puts it in an
iframe, so forbidding framing does not block them. Not run today against the simulator: NOT CHECKED. If a host ever
frames the page, relax `frame-ancestors` for `/app/` only, in `src/http.ts` (`APP_CSP`, `withAppHeaders`).

## Google endpoints (developers.google.com/identity/protocols/oauth2/web-server, read 2026-11-23)
- Authorization: `https://accounts.google.com/o/oauth2/v2/auth` with `client_id`, `redirect_uri`, `response_type=code`,
  `scope` (space-delimited), `access_type=offline`, `state`, `prompt=consent`.
- Token: `https://oauth2.googleapis.com/token`, `Content-Type: application/x-www-form-urlencoded`, with `code`,
  `client_id`, `client_secret`, `redirect_uri`, `grant_type=authorization_code`; answer `access_token`, `expires_in`,
  `refresh_token` (only with `access_type=offline`), `scope`, `token_type`.
- Scope strings: `calendar.readonly` is quoted on that page; `gmail.readonly`, `gmail.send`, `openid`, `email` and the
  `id_token` field are not on it: NOT CONFIRMED there.
