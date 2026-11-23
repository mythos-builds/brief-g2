# brief: the Cloudflare Worker

One Worker, `brief`, on `https://brief.appfinishers.com`:

| Path | What |
|---|---|
| `/app/`, `/app/<path>` | the built glasses app (`app/dist/`, job A), served from the `[assets]` binding; `/` and `/app` → 302 `/app/` |
| `/api/session`, `/api/items`, `/api/items/<id>/send`, `/api/items/<id>/skip`, `/api/pair/claim` | JSON, contract in `../../../BRIEF-D2.md` § 3 and `../../../BRIEF-D3.md` § 3 |
| `/api/calendar` | JSON, `BRIEF-D3.md` § 3.4: `{"mode","now","events":[{start,title,who,brief?}]}` |
| cron `*/2 * * * *` | the `scheduled` handler: the sync of the label `DEMO_LABEL` and the `primary` calendar (`BRIEF-D3.md` § 3.5) |
| `/connect`, `/oauth/start`, `/oauth/callback` | the Google sign-in pages → a 6-digit pairing code |
| `/healthz` | `{"ok":true}` |

State: ONE D1 database (`DB`), schema in `migrations/0001_init.sql` + `0002_sync.sql`. No KV, no Durable Object.
Nothing is ever sent, in any mode (`send` answers `{"sent":true,"real":false}`). Demo sessions: `src/demo-items.json`
and `src/demo-calendar.json`, frozen, no model and no Google call. Paired sessions (day 3): what the sync stored for
their ACCOUNT; every route only reads D1. Only the `scheduled` handler calls Google and the model.

## Files
- `src/index.ts`: the entry, default export only (workerd treats every named export of `main` as an entrypoint).
- `src/app.ts`: router, error handler (never a message or a stack in an answer), dev-only CORS.
- `src/api.ts`: the five `/api` routes. `src/oauth.ts`: Google sign-in. `src/pages.ts`: the HTML pages.
- `src/limits.ts`: rate limits and caps (one atomic `INSERT … ON CONFLICT … RETURNING` per counter, one batch per
  request), lazy purge. `src/crypto.ts`: tokens, SHA-256, codes, AES-256-GCM. `src/http.ts`: headers, CSP, body cap, log.
- `src/items.ts` + `src/demo-items.json`: the frozen demo items and their shape check.
- Day 3: `src/sync.ts` (the sync, § 3.5) · `src/google.ts` (the ONLY Google calls: token refresh, revoke, labels.list,
  messages.list, messages.get, events.list; the run cap of 40; the dev-only base addresses) · `src/stores.ts` (D1
  `ResultStore` and `CounterStore` for `../triage/once.ts` / `budget.ts`) · `src/paired.ts` (paired items, send/skip
  per account, calendar) · `src/personas.ts` + `src/personas.json` + `src/demo-calendar.json` (placeholders written by
  hand from the dataset; the CEO copies job B's `server/seed/` files over them) · `src/wiring.ts` (the ONE import of
  job B's `fromGmail`, `meetingBrief`, `validBrief`; tests inject fakes into `runSync`).
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

## Day 3 deploy (the CEO only, after the day-2 steps above are live)
1. Migration first (it adds columns the new code reads): `npx wrangler d1 migrations apply brief --remote` → applies
   `0002_sync.sql` only (`0001` is recorded as applied). Accounts signed in before day 3 get `needs_signin = 1`: their
   paired sessions answer 403 `signin_needed` until the next sign-in at `/connect` (it stores `self_hash`).
2. The model key, piped from a file, never typed: `npx wrangler secret put OPENROUTER_API_KEY < "$S/openrouter-key"`.
   Without it the sync triages nothing and logs `{"route":"sync.missing","name":"OPENROUTER_API_KEY"}`; routes work.
3. `npx wrangler deploy --dry-run`, then `npx wrangler deploy` in its own command. The cron comes from `[triggers]` in
   `wrangler.toml`; check it is listed in the deploy output and in the dashboard (Worker → Settings → Triggers).
   (The dry run does not print triggers: seen 2026-11-23 with wrangler 4.160.0.)
4. New vars are in `wrangler.toml` (`DEMO_LABEL`, `DISPLAY_TZ`, `TRIAGE_DAILY_CAP`, `MODEL_PROVIDER`). The five dev
   base addresses are NEVER set in production; they are ignored there anyway (`ENV` is not `"dev"`).
5. From outside, with a demo session: `GET /api/calendar` → `{"mode":"demo","now":"12:41",…}`. After the owner's
   sign-in and one sync: `GET /api/items` and `/api/calendar` with the paired session. Logs: `npx wrangler tail`
   shows `sync.*` lines with counts and codes only.

## Local run (dummies only, nothing leaves 127.0.0.1)
1. `cp .dev.vars.example .dev.vars` (git-ignored): `ENV="dev"`, the dev client id `dev-client-id`, the dev account
   `demo@example.com`, a dummy model key, and the five base addresses pointing at job B's fake on port 8799.
2. Terminal 1, the fake of Google and the model: `cd app/server && node scripts/fake-upstreams.ts --port 8799`.
3. Terminal 2, the Worker with the cron exposed: `npx wrangler d1 migrations apply brief --local`, then
   `npx wrangler dev --ip 127.0.0.1 --test-scheduled` → `http://127.0.0.1:8787` (CORS for `http://127.0.0.1:5173` only).
4. Sign in against the fake: `curl -si http://127.0.0.1:8787/oauth/start` → copy `state` from the `location` header →
   `curl -s "http://127.0.0.1:8787/oauth/callback?state=<state>&code=dev"` → the page shows a 6-digit code (the fake's
   token endpoint answers for `demo@example.com`, in `ALLOWED_ACCOUNTS` of `.dev.vars`).
5. `curl -s -X POST http://127.0.0.1:8787/api/pair/claim -d '{"code":"<code>"}'` → a paired session.
6. One sync: `curl -s "http://127.0.0.1:8787/__scheduled?cron=*/2+*+*+*+*"` (logs `sync.done` with the counts), then
   `GET /api/items` and `GET /api/calendar` with `Authorization: Bearer <session>`. `curl -s http://127.0.0.1:8799/_seen`
   lists what the Worker called (method and path). A second `/__scheduled` makes no model call and no `messages/<id>`.
7. Stop both (Ctrl-C). The code `dead` at step 4 gives a refresh token the fake refuses (`invalid_grant`): the next
   sync marks the account and both routes answer 403 `signin_needed` until a new sign-in.

## Security choices
- Tokens: 32 random bytes, base64url (43 chars); only their SHA-256 is stored; read only from `Authorization: Bearer`.
  OAuth states and pairing codes are stored as SHA-256 too; e-mails as SHA-256 only (`accounts.email_hash`).
- Refresh token: AES-256-GCM, a fresh 12-byte IV per record, the e-mail hash as additional data, key = `TOKEN_KEY`.
  The allow-list is checked on the verified e-mail of the `id_token` BEFORE anything is written; any other account
  gets the 403 page, its tokens are never stored, and its grant is REVOKED: one POST to
  `https://oauth2.googleapis.com/revoke` with `token=<refresh token, else access token>`, best effort, never logged
  (D2 review note 8; the page: « makes a request to https://oauth2.googleapis.com/revoke and includes the token as a
  parameter », `Content-type: application/x-www-form-urlencoded`, 200 on success, 400 with an error code otherwise).
- Day 3: the access token is cached sealed like the refresh token (AAD `access:<email hash>`), renewed under 5 minutes
  left; `invalid_grant` on refresh → `needs_signin = 1` → the account is skipped and its sessions get 403
  `signin_needed` until a new sign-in. Stored per message: Gmail ids, persona key, time, state, the validated triage
  result; per event: id, start, title (≤ 60, refused if it breaks the reply character rules), persona, the validated
  brief. Never a body, a subject, a real address or a clear token. A stored result or brief is validated again before
  it is served. `self_hash` = SHA-256 of the lower-cased address (what job B's parser compares senders with).
- The sync: 40 outgoing requests per run at most (Google + model, counted; at the cap it stops cleanly), 5 new
  messages and 2 briefs per run, 3 tries per message, one atomic claim per message (two runs never triage the same
  message twice), the daily model cap `TRIAGE_DAILY_CAP` in D1 (`counters`, key `triage:<UTC date>`).
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

## Google reading calls (day 3; reference pages read 2026-11-23, quoted in `src/google.ts`)
- Refresh: `POST https://oauth2.googleapis.com/token`, form `client_id`, `client_secret`, `grant_type=refresh_token`,
  `refresh_token` → `access_token`, `expires_in`. A dead grant → 400 `invalid_grant`.
- `GET https://gmail.googleapis.com/gmail/v1/users/me/labels` → `labels[]` (`id`, `name`, …).
- `GET …/users/me/messages?labelIds=<id>&maxResults=20` → `messages[]` (`id`, `threadId` only).
- `GET …/users/me/messages/<id>?format=full`, only for an id that the list returned in the same run. The page names the
  `format` parameter but its values (`full`, …) are on a linked page not read: `full` NOT CONFIRMED there (the brief's).
- `GET https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin&timeMax&singleEvents=true&orderBy=startTime&maxResults=5`;
  kept only when `creator.self` or `organizer.self` is true; all-day events (no `start.dateTime`) and `cancelled` are skipped.
