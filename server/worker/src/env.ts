// The Worker's bindings, vars and secrets (wrangler.toml). Secrets are read from here only, never logged.
import type { AiRun } from '../../triage/spoken.ts'

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
  /** Day 4 (BRIEF-D4 § 3.9): a real mail leaves ONLY when this is exactly "on" ("off" in wrangler.toml). */
  REAL_SEND?: string
  /** Real sends per account per UTC day (default "20"), counted when a send is claimed, never given back. */
  SEND_DAILY_CAP?: string
  /**
   * Day 5 (BRIEF-D5 § 3.8): the `[ai]` binding (Workers AI). It always reaches the LIVE service: only index.ts reads
   * it (voice.ts aiOf), no test ever calls it, and a dev Worker never uses it.
   */
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> }
  /** Dev-only (.dev.vars): job B's local fake of Workers AI, read ONLY when ENV is "dev". */
  AI_BASE?: string
  /** « Speak a change » is offered only when this is exactly "on". */
  VOICE?: string
  /** The Workers AI units all users together may use in one UTC day (default "3000"). */
  VOICE_DAILY_NEURONS?: string
}

/** What the Worker reaches outside itself. Tests pass a stub; production wraps the global fetch (bound, finding 10). */
export interface Deps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  now: () => number // Unix seconds
  /** The time limit of each Google call of a send (BRIEF-D4 § 3.3: 8 s). Tests only shorten it. */
  sendCallLimitMs?: number
  /**
   * Day 5: Workers AI (§ 3.8). Production = the binding, dev = the local fake over HTTP (both built by aiOf in
   * index.ts); tests inject a scripted one. Absent = the speak route answers 502 voice_failed (`at: "config"`).
   */
  ai?: AiRun
  /** The time limits of the speech call (10 s) and of each rewrite call (8 s). Tests only shorten them. */
  sttLimitMs?: number
  llmLimitMs?: number
}

/**
 * The lower-cased e-mail list of the secret ALLOWED_ACCOUNTS (read again on every request and every sync run,
 * BRIEF-D4 § 3.6). Empty or missing = nobody is allowed.
 */
export function allowedAccounts(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_ACCOUNTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  )
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
