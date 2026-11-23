// triage(item, opts) → { needs_reply, summary, draft, alts, provider }
// Runs under Node 24 (`node file.ts`) and inside a Cloudflare Worker: no Node API here,
// only fetch. This module only returns text; it never sends anything.
import { triageOpenRouter } from './openrouter.ts';
import { triageClaude } from './claude.ts';
import { readEnv } from './chain.ts';
import { TriageError } from './types.ts';
import type { Item, TriageOptions, TriageResult } from './types.ts';

export { TriageError } from './types.ts';
export type { Attempt, FetchLike, Item, ModelCooldown, RequestBudget, TriageOptions, TriageResult } from './types.ts';
export { memoryBudget, memoryCounterStore, dailyBudget, allBudgets, dayKey } from './budget.ts';
export type { CounterStore } from './budget.ts';
export { FREE_CHAIN } from './openrouter.ts';
export { LIMITS } from './validate.ts';

/** 'openrouter' or 'claude' (opts.provider, then env MODEL_PROVIDER, default openrouter); anything else throws. */
export function providerOf(opts: TriageOptions): 'openrouter' | 'claude' {
  const provider = (opts.provider ?? readEnv('MODEL_PROVIDER', opts) ?? 'openrouter').trim().toLowerCase();
  if (provider === 'claude' || provider === 'openrouter') return provider;
  throw new TriageError('bad_provider'); // the value itself is never echoed (finding 4)
}

/** The OpenRouter key (opts, then env), or the missing_key error that names it. */
export function openRouterKey(opts: TriageOptions): string {
  const apiKey = opts.apiKey ?? readEnv('OPENROUTER_API_KEY', opts);
  if (!apiKey) throw new TriageError('missing_key');
  return apiKey;
}

export async function triage(item: Item, opts: TriageOptions = {}): Promise<TriageResult> {
  if (providerOf(opts) === 'claude') return triageClaude(item, opts);
  return triageOpenRouter(item, { ...opts, apiKey: openRouterKey(opts) });
}
