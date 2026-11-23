// The seed's logic (no I/O): dataset → 10 triage calls (once each) → the demo items file of BRIEF-D2 § 3.10.
// scripts/seed-demo.ts is the command line around it. Node 24, no dependency.
import { buildItems } from '../../src/logic/items.ts';
import { replyProblem } from '../../src/logic/replies.ts';
import type { Dataset, Item as AppItem } from '../../src/logic/types.ts';
import { TriageError, memoryBudget } from '../triage/index.ts';
import type { FetchLike, Item as TriageItem, ModelCooldown, TriageResult } from '../triage/index.ts';
import { triageOnce, memoryResultStore } from '../triage/once.ts';

export const MAX_REQUESTS = 20;
export const EXPECTED_NEED = 3;

export interface Row {
  id: string; // the app's ids (items.ts: `mail-${i}`, `tg-${i}`, 0-based)
  source: 'mail' | 'telegram';
  item: TriageItem;
}

/** The 10 dataset messages, in dataset order, as the triage layer sees them (labels never included). */
export function rowsOf(ds: Dataset): Row[] {
  const nameOf = (key: string): string => ds.personas[key]?.name ?? key;
  const rows: Row[] = [];
  ds.mail.forEach((m, i) => rows.push({
    id: `mail-${i}`, source: 'mail',
    item: { from: m.from, fromName: nameOf(m.from), at: m.at, subject: m.subject, body: m.body },
  }));
  ds.telegram.forEach((t, i) => rows.push({
    id: `tg-${i}`, source: 'telegram',
    item: { from: t.from, fromName: nameOf(t.from), chat: t.chat, at: t.at, text: t.text },
  }));
  return rows;
}

export interface Line {
  id: string;
  expected: boolean; // the app shows it (buildItems)
  result: TriageResult | null;
  ms: number;
  error: string; // a TriageError message (codes and statuses only) or ''
}

export interface SeedRun {
  lines: Line[];
  requests: number;
  items: AppItem[];
  /** Why the file must not be written; empty = write it. */
  problems: string[];
}

export interface SeedOptions {
  apiKey: string;
  /** Per row: the fetch to use (the dry run replays fixtures); undefined = the real fetch. */
  fetchFor?: (rowId: string) => FetchLike | undefined;
  maxRequests?: number;
}

export async function runSeed(ds: Dataset, opts: SeedOptions): Promise<SeedRun> {
  const shown = buildItems(ds, ['mail', 'telegram']); // identity fields and display order, as the app builds them
  const shownIds = new Set(shown.map((i) => i.id));
  const budget = memoryBudget(opts.maxRequests ?? MAX_REQUESTS);
  const cooldown: ModelCooldown = new Map();
  const store = memoryResultStore();
  let requests = 0;
  const lines: Line[] = [];
  const results = new Map<string, TriageResult>();

  for (const row of rowsOf(ds)) {
    const t0 = Date.now();
    let result: TriageResult | null = null;
    let error = '';
    try {
      result = await triageOnce(row.id, row.item, store, {
        provider: 'openrouter',
        apiKey: opts.apiKey,
        budget,
        cooldown,
        fetch: opts.fetchFor?.(row.id),
        onAttempt: () => { requests += 1; },
      });
      results.set(row.id, result);
    } catch (e) {
      error = e instanceof TriageError ? e.message : 'error';
    }
    lines.push({ id: row.id, expected: shownIds.has(row.id), result, ms: Date.now() - t0, error });
  }

  const problems: string[] = [];
  const failed = lines.filter((l) => l.result === null).map((l) => l.id);
  if (failed.length) problems.push(`no valid answer for ${failed.join(', ')}`);
  const need = lines.filter((l) => l.result?.needs_reply).map((l) => l.id);
  if (need.length !== EXPECTED_NEED) problems.push(`${need.length} items need a reply (expected exactly ${EXPECTED_NEED})`);
  const mismatch = lines.filter((l) => l.result && l.result.needs_reply !== l.expected).map((l) => l.id);
  if (mismatch.length) problems.push(`the model and the app disagree on ${mismatch.join(', ')}`);

  const items: AppItem[] = [];
  if (problems.length === 0) {
    for (const base of shown) {
      const r = results.get(base.id);
      if (!r) continue; // unreachable: every row has a result here
      items.push({ ...base, summary: r.summary, draft: r.draft, alts: [...r.alts] });
    }
    const bad = checkDemoFile({ generated_at: new Date().toISOString(), items });
    if (bad) problems.push(bad);
    // D2 review, finding 4: the app's own check (what the G2 can draw, its rules): a text the app would drop never
    // reaches the file, or judges would see B without « Send » or a missing alternative.
    for (const it of items) {
      const d = replyProblem(it.draft, 'draft');
      if (d) problems.push(`${it.id} draft: ${d}`);
      it.alts.forEach((a, n) => {
        const p = replyProblem(a, 'alt');
        if (p) problems.push(`${it.id} alts[${n}]: ${p}`);
      });
    }
  }
  return { lines, requests, items: problems.length ? [] : items, problems };
}

const ITEM_KEYS = ['id', 'source', 'persona', 'name', 'fullName', 'address', 'chat', 'at', 'summary', 'draft', 'alts'];
const REQUIRED = ITEM_KEYS.filter((k) => k !== 'chat');

/** null when `obj` is a valid demo-items file (BRIEF-D2 § 3.10), else the first reason it is not. */
export function checkDemoFile(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  const o = obj as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'generated_at,items') return `top-level keys are ${keys}`;
  if (typeof o.generated_at !== 'string' || Number.isNaN(Date.parse(o.generated_at)) || new Date(o.generated_at).toISOString() !== o.generated_at) return 'generated_at is not an ISO time';
  if (!Array.isArray(o.items)) return 'items is not an array';
  if (o.items.length !== EXPECTED_NEED) return `${o.items.length} items (need ${EXPECTED_NEED})`;
  const ids = new Set<string>();
  for (const [n, it] of o.items.entries()) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return `items[${n}] is not an object`;
    const i = it as Record<string, unknown>;
    for (const k of Object.keys(i)) if (!ITEM_KEYS.includes(k)) return `items[${n}] has an extra field ${k}`;
    for (const k of REQUIRED) if (k !== 'alts' && (typeof i[k] !== 'string' || i[k] === '')) return `items[${n}].${k} is not a non-empty string`;
    if (i.source !== 'mail' && i.source !== 'telegram') return `items[${n}].source is ${String(i.source)}`;
    if (i.source === 'telegram' ? typeof i.chat !== 'string' : 'chat' in i) return `items[${n}].chat does not match its source`;
    if (!Array.isArray(i.alts) || i.alts.length !== 4 || i.alts.some((a) => typeof a !== 'string' || a === '')) return `items[${n}].alts is not 4 strings`;
    if (ids.has(i.id as string)) return `items[${n}].id is repeated`;
    ids.add(i.id as string);
  }
  return null;
}

/** The output file's text. */
export function demoFileText(items: AppItem[], at: Date = new Date()): string {
  return `${JSON.stringify({ generated_at: at.toISOString(), items }, null, 2)}\n`;
}
