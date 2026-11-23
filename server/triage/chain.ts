// One request loop for every provider and every task (triage, meeting brief): a chain of models tried in order.
// A 429, a 5xx, a timeout, a network error or an invalid answer on one model = try the next.
// All failed = TriageError('all_failed'); never a made-up result. Only fetch is used (Worker-safe, no Node API).
import { TriageError } from './types.ts';
import type { Attempt, FetchLike, TriageOptions } from './types.ts';

export const DEFAULT_TIMEOUT_MS = 20_000;
/** One total deadline per call, all models together (D1 review, finding 7). */
export const DEFAULT_DEADLINE_MS = 25_000;
/** A model that answered 429 is put aside at least this long (D1 review, finding 7). */
export const MIN_COOLDOWN_MS = 60_000;

export type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ChainSpec<T> {
  /** "openrouter" or "claude": the provider string is `${prefix}:${model}`. */
  prefix: string;
  url: string;
  models: string[];
  headers: Record<string, string>;
  body(model: string): string;
  /** From the raw 200 body to the model's text; throws or returns a reason when the body is unusable. */
  content(raw: string): Check<unknown>;
  /** From the model's text to a checked value (validate.ts / brief.ts). */
  check(content: unknown): Check<T>;
}

/** retry_after (seconds) from a 429 body, when the provider gives one; never more than an hour. */
export function retryAfterMs(bodyText: string): number {
  const m = /"retry_after(?:_seconds)?"\s*:\s*(\d+(?:\.\d+)?)/.exec(bodyText);
  const s = m ? Number(m[1]) : 0;
  return Math.min(Math.max(s * 1000, MIN_COOLDOWN_MS), 3_600_000);
}

export async function runChain<T>(spec: ChainSpec<T>, opts: TriageOptions): Promise<T & { provider: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  // Bound: workerd throws "Illegal invocation" when fetch is called with a wrong `this` (D1 review, note 10).
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch.bind(globalThis) as unknown as FetchLike);
  const attempts: Attempt[] = [];
  const started = now();

  const record = (a: Attempt): void => {
    if (!opts.debugRaw) delete a.raw;
    attempts.push(a);
    if (opts.onAttempt) opts.onAttempt(a);
  };

  for (const model of spec.models) {
    const until = opts.cooldown?.get(model);
    if (until !== undefined && until > now()) continue; // 429 earlier in this run: no request spent on it
    const remaining = deadlineMs - (now() - started);
    if (remaining <= 0) break;
    if (opts.budget && !(await opts.budget.take())) {
      throw new TriageError('budget_exhausted', attempts);
    }
    const provider = `${spec.prefix}:${model}`;
    const controller = new AbortController();
    let timedOut = false;
    const wait = Math.min(timeoutMs, remaining);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, wait);
    const t0 = now();
    let status: number | null = null;
    let raw = '';
    try {
      const res = await doFetch(spec.url, { method: 'POST', headers: spec.headers, body: spec.body(model), signal: controller.signal });
      status = res.status;
      raw = await res.text();
    } catch {
      clearTimeout(timer);
      const ms = now() - t0;
      // The thrown message is never kept (finding 4): it can quote a URL, a host or a body.
      if (timedOut) record({ provider, model, status, ms, outcome: 'timeout', reason: `no answer in ${wait} ms`, raw });
      else record({ provider, model, status, ms, outcome: 'network_error', reason: 'network error', raw });
      continue;
    }
    clearTimeout(timer);
    const ms = now() - t0;

    if (status !== 200) {
      if (status === 429 && opts.cooldown) opts.cooldown.set(model, now() + retryAfterMs(raw));
      record({ provider, model, status, ms, outcome: 'http_error', reason: `HTTP ${status}`, raw });
      continue;
    }
    let content: Check<unknown>;
    try {
      content = spec.content(raw);
    } catch {
      content = { ok: false, reason: 'response is not JSON' };
    }
    if (!content.ok) {
      record({ provider, model, status, ms, outcome: 'invalid', reason: content.reason, raw });
      continue;
    }
    const checked = spec.check(content.value);
    if (!checked.ok) {
      record({ provider, model, status, ms, outcome: 'invalid', reason: checked.reason, raw });
      continue;
    }
    record({ provider, model, status, ms, outcome: 'ok', reason: '', raw });
    return { ...checked.value, provider };
  }

  throw new TriageError('all_failed', attempts);
}

/** opts.env (Worker bindings) first, then process.env when a Node-like runtime has one. */
export function readEnv(name: string, opts: TriageOptions): string | undefined {
  if (opts.env && name in opts.env) return opts.env[name] || undefined;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] || undefined;
}

/** "https://x.example/" → "https://x.example"; refuses anything that is not http(s). */
export function cleanBase(base: string): string {
  const b = base.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/.test(b)) throw new TriageError('not_configured', [], 'the model base address is not an http(s) origin');
  return b;
}
