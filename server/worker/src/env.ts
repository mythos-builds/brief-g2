// The Worker's bindings, vars and secrets (wrangler.toml). Secrets are read from here only, never logged.
export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  /** "dev" = CORS for http://127.0.0.1:5173 only; anything else = no CORS. */
  ENV?: string
  OAUTH_REDIRECT_URI?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** base64 of 32 random bytes (AES-256-GCM key for refresh tokens). */
  TOKEN_KEY?: string
  /** Comma-separated e-mail addresses allowed to finish the Google sign-in. */
  ALLOWED_ACCOUNTS?: string
  /** Day 3 (BRIEF-D3 § 3.9): the ONE Gmail label read, the display time zone, the daily cap of model requests. */
  DEMO_LABEL?: string
  DISPLAY_TZ?: string
  TRIAGE_DAILY_CAP?: string
  MODEL_PROVIDER?: string
  CLAUDE_MODEL?: string
  /** Model keys (secrets). Absent = the sync triages nothing and logs the NAME; every route keeps working. */
  OPENROUTER_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  /** Dev-only base addresses (BRIEF-D3 § 3.8): read ONLY when ENV is "dev" (google.ts upstreams()). */
  GOOGLE_TOKEN_URL?: string
  GOOGLE_REVOKE_URL?: string
  GMAIL_BASE?: string
  CALENDAR_BASE?: string
  MODEL_BASE?: string
}

/** What the Worker reaches outside itself. Tests pass a stub; production wraps the global fetch (bound, finding 10). */
export interface Deps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  now: () => number // Unix seconds
}

export const liveDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  now: () => Math.floor(Date.now() / 1000),
}

/** Thrown when a secret or var the route needs is absent. The NAME goes to the log, never a value. */
export class MissingConfig extends Error {
  constructor(readonly names: string[]) {
    super(`missing configuration: ${names.join(', ')}`)
  }
}

export function requireConfig<K extends keyof Env>(env: Env, names: K[]): void {
  const missing = names.filter((n) => typeof env[n] !== 'string' || (env[n] as string).trim() === '')
  if (missing.length) throw new MissingConfig(missing as string[])
}
