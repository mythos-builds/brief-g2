// triage(item, opts) → { needs_reply, summary, draft, alts, provider }
// Runs under Node 24 (`node file.ts`) and inside a Cloudflare Worker: no Node API here,
// only fetch. This module only returns text; it never sends anything.
import { triageOpenRouter } from './openrouter.ts';
import { triageClaude } from './claude.ts';
import { TriageError } from './types.ts';
import type { Item, TriageOptions, TriageResult } from './types.ts';

export { TriageError } from './types.ts';
export type { Attempt, FetchLike, Item, ModelCooldown, RequestBudget, TriageOptions, TriageResult } from './types.ts';
export { memoryBudget, memoryCounterStore, dailyBudget, allBudgets, dayKey } from './budget.ts';
export type { CounterStore } from './budget.ts';
export { FREE_CHAIN } from './openrouter.ts';
export { LIMITS } from './validate.ts';

/** opts.env (Worker bindings) first, then process.env when a Node-like runtime has one. */
function readEnv(name: string, opts: TriageOptions): string | undefined {
  if (opts.env && name in opts.env) return opts.env[name] || undefined;
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

export async function triage(item: Item, opts: TriageOptions = {}): Promise<TriageResult> {
  const provider = (opts.provider ?? readEnv('MODEL_PROVIDER', opts) ?? 'openrouter').trim().toLowerCase();
  if (provider === 'claude') return triageClaude(item, opts);
  if (provider !== 'openrouter') {
    throw new TriageError('bad_provider'); // the value itself is never echoed (finding 4)
  }
  const apiKey = opts.apiKey ?? readEnv('OPENROUTER_API_KEY', opts);
  if (!apiKey) {
    throw new TriageError('missing_key');
  }
  return triageOpenRouter(item, { ...opts, apiKey });
}
