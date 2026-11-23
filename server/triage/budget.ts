// Request budgets (D1 review, finding 1). Async on purpose: a D1 row, a file or memory can back them.
// Worker-safe: no Node API.
import type { RequestBudget } from './types.ts';

/** A cap for ONE run (the seed script, check-live): n requests, then every take() says no. */
export function memoryBudget(n: number): RequestBudget & { left(): number } {
  let left = n;
  return {
    async take() {
      if (left <= 0) return false;
      left -= 1;
      return true;
    },
    left: () => left,
  };
}

/**
 * Persistent counters, one integer per key. incrementBelow must be ATOMIC: it adds 1 only when the
 * current value is below `limit`, and says whether it did. On D1 this is one statement, e.g.
 *   INSERT INTO counters(key, n) VALUES (?1, 1)
 *   ON CONFLICT(key) DO UPDATE SET n = n + 1 WHERE n < ?2 RETURNING n
 * (a row back = granted, no row = refused). Two callers at the same moment can never both pass the limit.
 */
export interface CounterStore {
  incrementBelow(key: string, limit: number): Promise<boolean>;
}

/** In-memory CounterStore (tests, one process). JS runs one microtask at a time, so this is atomic. */
export function memoryCounterStore(): CounterStore & { value(key: string): number } {
  const counts = new Map<string, number>();
  return {
    async incrementBelow(key, limit) {
      const n = counts.get(key) ?? 0;
      if (n >= limit) return false;
      counts.set(key, n + 1);
      return true;
    },
    value: (key) => counts.get(key) ?? 0,
  };
}

/** "triage:2026-11-23": one counter per UTC day. */
export function dayKey(prefix: string, epochMs: number): string {
  return `${prefix}:${new Date(epochMs).toISOString().slice(0, 10)}`;
}

/**
 * A daily cap shared by every caller of the same store (the key's 50 free requests a day):
 * checked BEFORE each model request, never after.
 */
export function dailyBudget(store: CounterStore, limit: number, now: () => number = Date.now, prefix = 'triage'): RequestBudget {
  return {
    take: () => store.incrementBelow(dayKey(prefix, now()), limit),
  };
}

/** Several budgets at once (e.g. per run AND per day): a request needs every one of them, in order. */
export function allBudgets(...budgets: RequestBudget[]): RequestBudget {
  return {
    async take() {
      for (const b of budgets) if (!(await b.take())) return false;
      return true;
    },
  };
}
