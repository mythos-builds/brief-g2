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

/** The text the model answered: message.content only (the reasoning field is ignored). */
function contentOf(bodyText: string): unknown {
  const data = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: unknown } }> };
  return data.choices?.[0]?.message?.content;
}

export async function triageOpenRouter(item: Item, opts: TriageOptions & { apiKey: string }): Promise<TriageResult> {
  const models = opts.models ?? FREE_CHAIN;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const messages = buildMessages(item);
  const attempts: Attempt[] = [];

  const record = (a: Attempt): void => {
    attempts.push(a);
    if (opts.onAttempt) opts.onAttempt(a);
  };

  for (const model of models) {
    if (opts.budget) {
      if (opts.budget.left <= 0) {
        throw new TriageError('budget_exhausted', `request budget used up before ${model}`, attempts);
      }
      opts.budget.left -= 1;
    }
    const provider = `openrouter:${model}`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const t0 = Date.now();
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
    } catch (e) {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (timedOut) record({ provider, model, status, ms, outcome: 'timeout', reason: `no answer in ${timeoutMs} ms`, raw });
      else record({ provider, model, status, ms, outcome: 'network_error', reason: (e as Error).message, raw });
      continue;
    }
    clearTimeout(timer);
    const ms = Date.now() - t0;

    if (status !== 200) {
      record({ provider, model, status, ms, outcome: 'http_error', reason: `HTTP ${status}`, raw });
      continue;
    }
    let content: unknown;
    try {
      content = contentOf(raw);
    } catch (e) {
      record({ provider, model, status, ms, outcome: 'invalid', reason: `response is not JSON: ${(e as Error).message}`, raw });
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

  const summary = attempts.map((a) => `${a.model}: ${a.reason || a.outcome}`).join('; ');
  throw new TriageError('all_failed', `every model failed (${summary})`, attempts);
}
