// OpenRouter provider: a chain of free models tried in order (measured 2026-11-21, PREP.md), through chain.ts.
// Only fetch is used. `opts.baseUrl` (BRIEF-D3 § 3.8) replaces the origin, for the local fake in dev only.
import { buildMessages } from './prompt.ts';
import { parseAnswer } from './validate.ts';
import { cleanBase, runChain } from './chain.ts';
import type { Check } from './chain.ts';
import type { Item, TriageOptions, TriageResult } from './types.ts';

export { DEFAULT_TIMEOUT_MS, DEFAULT_DEADLINE_MS, MIN_COOLDOWN_MS } from './chain.ts';

export const OPENROUTER_BASE = 'https://openrouter.ai';
export const OPENROUTER_PATH = '/api/v1/chat/completions';
export const OPENROUTER_URL = `${OPENROUTER_BASE}${OPENROUTER_PATH}`;
export const FREE_CHAIN = [
  'particle-ai/particle-1:free',
  'baidu/ernie-5.5-flash-preview:free',
  'recursive/flint-v1.0:free',
];

/** The text the model answered: message.content only (the reasoning field is ignored). */
function contentOf(bodyText: string): Check<unknown> {
  const data = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: unknown } }> };
  return { ok: true, value: data.choices?.[0]?.message?.content };
}

/** Any chat task on OpenRouter: system + user messages → a checked value. */
export function chatOpenRouter<T>(
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  check: (content: unknown) => Check<T>,
  opts: TriageOptions & { apiKey: string },
): Promise<T & { provider: string }> {
  const base = opts.baseUrl ? cleanBase(opts.baseUrl) : OPENROUTER_BASE;
  return runChain({
    prefix: 'openrouter',
    url: `${base}${OPENROUTER_PATH}`,
    models: opts.models ?? FREE_CHAIN,
    headers: { 'Authorization': `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    body: (model) => JSON.stringify({ model, messages, temperature: 0.2 }),
    content: contentOf,
    check,
  }, opts);
}

export function triageOpenRouter(item: Item, opts: TriageOptions & { apiKey: string }): Promise<TriageResult> {
  return chatOpenRouter(buildMessages(item), parseAnswer, opts);
}
