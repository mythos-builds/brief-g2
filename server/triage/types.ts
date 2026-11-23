// Shapes shared by the triage layer. Erasable TypeScript only (runs under `node file.ts`
// with type stripping, and later inside a Cloudflare Worker): no enum, no namespace,
// no parameter property, no Node API.

/** A mail as in demo/dataset.json (only the fields the model may see are read). */
export interface MailItem {
  kind?: 'mail';
  from: string;
  /** Display name of the sender, when the caller knows it (personas map). */
  fromName?: string;
  at?: string;
  subject: string;
  body?: string;
}

/** A Telegram message as in demo/dataset.json. */
export interface ChatItem {
  kind?: 'telegram';
  from: string;
  fromName?: string;
  chat: string;
  at?: string;
  text: string;
  mentions_user?: boolean;
  muted?: boolean;
}

export type Item = MailItem | ChatItem;

export interface TriageResult {
  needs_reply: boolean;
  /** 6 words at most. */
  summary: string;
  /** A reply of 2 short lines at most; "" when needs_reply is false. */
  draft: string;
  /** Exactly 4 replies (yes · no · later · a question) when needs_reply is true; [] when false. */
  alts: string[];
  /** Which engine answered, e.g. "openrouter:particle-ai/particle-1:free". */
  provider: string;
}

export type AttemptOutcome = 'ok' | 'http_error' | 'timeout' | 'network_error' | 'invalid';

/** One HTTP request to one model, reported through opts.onAttempt. */
export interface Attempt {
  provider: string;
  model: string;
  status: number | null;
  ms: number;
  outcome: AttemptOutcome;
  /** Codes and numbers only (e.g. "HTTP 429", "alts[1] is 79 characters"): never model text, never an upstream body. */
  reason: string;
  /** The raw response body, ONLY when opts.debugRaw is true (check-live's local cache). A Worker never sets it. */
  raw?: string;
}

/**
 * Request budget (D1 review, finding 1): ASYNC, so a D1 row, a file or a memory counter can implement it.
 * take() reserves ONE model request atomically and says whether it may be made; false = refused, no request.
 * See budget.ts: memoryBudget(n) for one run, dailyBudget(store, limit) for a persistent daily cap.
 */
export interface RequestBudget {
  take(): Promise<boolean>;
}

/** Models put aside after a 429, shared across the calls of one run (D1 review, finding 7). model → epoch ms. */
export type ModelCooldown = Map<string, number>;

export type FetchLike = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}) => Promise<{ status: number; text(): Promise<string> }>;

export interface TriageOptions {
  /** 'openrouter' (default) or 'claude'. Falls back to env MODEL_PROVIDER. */
  provider?: string;
  /** OpenRouter key. Falls back to env OPENROUTER_API_KEY. Never logged. */
  apiKey?: string;
  /** Model chain to try in order (default: the 11-21 chain). */
  models?: string[];
  /** Per-request timeout, ms (default 20000). */
  timeoutMs?: number;
  /** Injected fetch (tests use recorded fixtures); default globalThis.fetch. */
  fetch?: FetchLike;
  /** Request counter shared across calls; a request is refused when it reaches 0. */
  budget?: RequestBudget;
  /** Called after every request, success or not. */
  onAttempt?: (attempt: Attempt) => void;
  /** One total deadline for the whole call, all models together, ms (default 25000). */
  deadlineMs?: number;
  /** Shared across calls: a model that answered 429 is skipped until its time (>= 60 s, or the body's retry_after). */
  cooldown?: ModelCooldown;
  /** Clock, epoch ms (tests). Default Date.now. */
  now?: () => number;
  /** Keep each raw response body in Attempt.raw (check-live only). Never set in a Worker. */
  debugRaw?: boolean;
  /** Worker-style env object (bindings); read before globalThis.process.env. */
  env?: Record<string, string | undefined>;
}

export type TriageErrorCode =
  | 'not_configured'
  | 'missing_key'
  | 'all_failed'
  | 'budget_exhausted'
  | 'bad_provider';

/**
 * The only error triage() throws. It never carries a made-up result.
 * D1 review, finding 4: `message` = the code, plus HTTP statuses and outcome codes only
 * (e.g. "all_failed: 429 503 invalid"); never a raw answer, a model text, an account id or a V8 parse message.
 * `attempts` never hold a raw body (raw is dropped here even when debugRaw was set).
 */
const HINT: Record<TriageErrorCode, string> = {
  not_configured: 'MODEL_PROVIDER=claude is not configured yet (stub until 2026-11-27)',
  missing_key: 'OPENROUTER_API_KEY is not set',
  all_failed: 'every model failed',
  budget_exhausted: 'request budget used up',
  bad_provider: 'MODEL_PROVIDER must be "openrouter" or "claude"',
};

export class TriageError extends Error {
  code: TriageErrorCode;
  attempts: Attempt[];
  constructor(code: TriageErrorCode, attempts: Attempt[] = []) {
    const codes = attempts.map((a) => (a.status !== null && a.status !== 200 ? String(a.status) : a.outcome));
    super(`${code}: ${HINT[code]}${codes.length ? ` (${codes.join(' ')})` : ''}`);
    this.name = 'TriageError';
    this.code = code;
    this.attempts = attempts.map(({ raw: _raw, ...rest }) => rest);
  }
}
