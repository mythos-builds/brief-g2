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
  reason: string;
  /** The raw response body text (for the .cache of check-live), never parsed by the caller. */
  raw: string;
}

/** Shared request counter: one object passed to many triage() calls caps a whole run. */
export interface RequestBudget {
  left: number;
}

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
  /** Worker-style env object (bindings); read before globalThis.process.env. */
  env?: Record<string, string | undefined>;
}

export type TriageErrorCode =
  | 'not_configured'
  | 'missing_key'
  | 'all_failed'
  | 'budget_exhausted'
  | 'bad_provider';

/** The only error triage() throws. It never carries a made-up result. */
export class TriageError extends Error {
  code: TriageErrorCode;
  attempts: Attempt[];
  constructor(code: TriageErrorCode, message: string, attempts: Attempt[] = []) {
    super(message);
    this.name = 'TriageError';
    this.code = code;
    this.attempts = attempts;
  }
}
