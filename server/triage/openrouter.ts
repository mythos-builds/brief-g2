// OpenRouter provider: a chain of free models tried in order (measured 2026-11-21, PREP.md).
// A 429, a 5xx, a timeout, a network error or an invalid answer on one model = try the next.
// All failed = TriageError('all_failed'); never a made-up result. Only fetch is used.
import { buildMessages } from './prompt.ts';
import { parseAnswer } from './validate.ts';
import { TriageError } from './types.ts';
import type { Attempt, FetchLike, Item, TriageOptions, TriageResult } from './types.ts';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const FREE_CHAIN = [
  'particle-ai/particle-1:free',
  'baidu/ernie-5.5-flash-preview:free',
  'recursive/flint-v1.0:free',
];
export const DEFAULT_TIMEOUT_MS = 20_000;
/** One total deadline per call, all models together (D1 review, finding 7). */
export const DEFAULT_DEADLINE_MS = 25_000;
/** A model that answered 429 is put aside at least this long (D1 review, finding 7). */
export const MIN_COOLDOWN_MS = 60_000;

/** The text the model answered: message.content only (the reasoning field is ignored). */
function contentOf(bodyText: string): unknown {
  const data = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: unknown } }> };
  return data.choices?.[0]?.message?.content;
}

/** retry_after (seconds) from a 429 body, when OpenRouter gives one; never more than an hour. */
function retryAfterMs(bodyText: string): number {
  const m = /"retry_after(?:_seconds)?"\s*:\s*(\d+(?:\.\d+)?)/.exec(bodyText);
  const s = m ? Number(m[1]) : 0;
  return Math.min(Math.max(s * 1000, MIN_COOLDOWN_MS), 3_600_000);
}

export async function triageOpenRouter(item: Item, opts: TriageOptions & { apiKey: string }): Promise<TriageResult> {
  const models = opts.models ?? FREE_CHAIN;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  // Bound: workerd throws "Illegal invocation" when fetch is called with a wrong `this` (D1 review, note 10).
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch.bind(globalThis) as unknown as FetchLike);
  const messages = buildMessages(item);
  const attempts: Attempt[] = [];
  const started = now();

  const record = (a: Attempt): void => {
    if (!opts.debugRaw) delete a.raw;
    attempts.push(a);
    if (opts.onAttempt) opts.onAttempt(a);
  };

  for (const model of models) {
    const until = opts.cooldown?.get(model);
    if (until !== undefined && until > now()) continue; // 429 earlier in this run: no request spent on it
    const remaining = deadlineMs - (now() - started);
    if (remaining <= 0) break;
    if (opts.budget && !(await opts.budget.take())) {
      throw new TriageError('budget_exhausted', attempts);
    }
    const provider = `openrouter:${model}`;
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
      const res = await doFetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, messages, temperature: 0.2 }),
        signal: controller.signal,
      });
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
    let content: unknown;
    try {
      content = contentOf(raw);
    } catch {
      record({ provider, model, status, ms, outcome: 'invalid', reason: 'response is not JSON', raw });
      continue;
    }
    const checked = parseAnswer(content);
    if (!checked.ok) {
      record({ provider, model, status, ms, outcome: 'invalid', reason: checked.reason, raw });
      continue;
    }
    record({ provider, model, status, ms, outcome: 'ok', reason: '', raw });
    return { ...checked.value, provider };
  }

  throw new TriageError('all_failed', attempts);
}
