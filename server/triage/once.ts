// triageOnce (D1 review, finding 1): each message is triaged ONCE, keyed by its id; the result is stored and
// every later call returns the stored result WITHOUT any model call. Public routes only ever read the store.
// Worker-safe: no Node API.
import { triage } from './index.ts';
import type { Item, TriageOptions, TriageResult } from './types.ts';

/** Where triage results live, by message id (on D1: one row per id). put must not overwrite an existing id. */
export interface ResultStore {
  get(id: string): Promise<TriageResult | null>;
  put(id: string, result: TriageResult): Promise<void>;
}

export function memoryResultStore(): ResultStore & { size(): number } {
  const rows = new Map<string, TriageResult>();
  return {
    async get(id) {
      const r = rows.get(id);
      return r ? { ...r, alts: [...r.alts] } : null;
    },
    async put(id, result) {
      if (!rows.has(id)) rows.set(id, { ...result, alts: [...result.alts] });
    },
    size: () => rows.size,
  };
}

// Calls in flight in this process, per store: two calls for the same id at the same moment share one triage.
const inFlight = new WeakMap<ResultStore, Map<string, Promise<TriageResult>>>();

export async function triageOnce(id: string, item: Item, store: ResultStore, opts: TriageOptions = {}): Promise<TriageResult> {
  const stored = await store.get(id);
  if (stored) return stored;
  let mine = inFlight.get(store);
  if (!mine) {
    mine = new Map();
    inFlight.set(store, mine);
  }
  const pending = mine.get(id);
  if (pending) return pending;
  const run = (async () => {
    try {
      const result = await triage(item, opts);
      await store.put(id, result);
      // Read back: if another process stored first, everyone uses that one.
      return (await store.get(id)) ?? result;
    } finally {
      mine.delete(id);
    }
  })();
  mine.set(id, run);
  return run;
}
