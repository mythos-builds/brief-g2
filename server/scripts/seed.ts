// The seed's logic (no I/O): dataset → 10 triage calls (once each) → the demo items file of BRIEF-D2 § 3.10.
// scripts/seed-demo.ts is the command line around it. Node 24, no dependency.
import { buildItems, companyOf } from '../../src/logic/items.ts';
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

// ---- BRIEF-D3 § 3.6: the persona table and the frozen demo calendar (no model call; deterministic) ----

export interface PersonaRow { key: string; name: string; fullName: string; address: string; company: string }
export interface CalendarEvent { start: string; title: string; who: string; brief?: { why: string; last: string; facts: string[] } }

export const DEMO_NOW = '12:41';
export const EVENT_LIMITS = { title: 60, line: 60, factsMin: 1, factsMax: 4, events: 5 } as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The dataset's personas that have an email, in dataset order: name = first name, company = the app's companyOf. */
export function personasOf(ds: Dataset): PersonaRow[] {
  const rows: PersonaRow[] = [];
  for (const [key, p] of Object.entries(ds.personas)) {
    if (!p.email) continue;
    rows.push({ key, name: p.name.split(/\s+/)[0], fullName: p.name, address: p.email, company: companyOf(p.email) ?? '' });
  }
  return rows;
}

/** "<fullName>, <company>" or "" (BRIEF-D3 § 3.4). */
export function whoOf(ds: Dataset, key: string): string {
  const p = personasOf(ds).find((r) => r.key === key);
  return p ? `${p.fullName}${p.company ? `, ${p.company}` : ''}` : '';
}

/** Today's dataset events that start after DEMO_NOW, in order, 5 at most. */
export function demoCalendarOf(ds: Dataset): { now: string; events: CalendarEvent[] } {
  const events = ds.calendar
    .filter((e) => e.start > DEMO_NOW)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, EVENT_LIMITS.events)
    .map((e) => {
      const ev: CalendarEvent = { start: e.start, title: e.title, who: whoOf(ds, e.with) };
      if (e.brief) ev.brief = { why: e.brief.why, last: e.brief.last, facts: [...e.brief.facts] };
      return ev;
    });
  return { now: DEMO_NOW, events };
}

const oneLine = (v: unknown, max: number): boolean => typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\r\n]/.test(v);

/** null when `obj` is a valid personas file (§ 3.6), else the first reason. */
export function checkPersonasFile(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  const o = obj as Record<string, unknown>;
  if (Object.keys(o).join(',') !== 'personas') return 'top-level keys are not exactly personas';
  if (!Array.isArray(o.personas) || o.personas.length === 0) return 'personas is not a non-empty array';
  const keys = new Set<string>();
  for (const [n, p] of o.personas.entries()) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return `personas[${n}] is not an object`;
    const r = p as Record<string, unknown>;
    if (Object.keys(r).sort().join(',') !== 'address,company,fullName,key,name') return `personas[${n}] fields are not key,name,fullName,address,company`;
    for (const k of ['key', 'name', 'fullName', 'address', 'company']) if (typeof r[k] !== 'string' || r[k] === '') return `personas[${n}].${k} is not a non-empty string`;
    if (!/^[a-z0-9]{1,32}$/.test(r.key as string)) return `personas[${n}].key is not a plain tag`;
    if (!/\.example\.(com|net|org)$/.test(r.address as string)) return `personas[${n}].address is not a fictional example address`;
    if (keys.has(r.key as string)) return `personas[${n}].key is repeated`;
    keys.add(r.key as string);
  }
  return null;
}

/** null when `obj` is a valid demo calendar file (§ 3.4 and 3.6), else the first reason. */
export function checkCalendarFile(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  const o = obj as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'events,now') return 'top-level keys are not exactly now,events';
  if (o.now !== DEMO_NOW) return `now is not "${DEMO_NOW}"`;
  if (!Array.isArray(o.events) || o.events.length > EVENT_LIMITS.events) return 'events is not an array of 5 at most';
  let prev = '';
  for (const [n, e] of o.events.entries()) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return `events[${n}] is not an object`;
    const r = e as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!['start', 'title', 'who', 'brief'].includes(k)) return `events[${n}] has an extra field ${k}`;
    if (typeof r.start !== 'string' || !HHMM.test(r.start)) return `events[${n}].start is not HH:MM`;
    if (r.start <= DEMO_NOW) return `events[${n}] does not start after now`;
    if (r.start < prev) return `events[${n}] is out of order`;
    prev = r.start;
    if (!oneLine(r.title, EVENT_LIMITS.title)) return `events[${n}].title is not one line of 1 to 60 characters`;
    if (typeof r.who !== 'string' || /[\r\n]/.test(r.who)) return `events[${n}].who is not a one-line string`;
    if ('brief' in r) {
      const b = r.brief as Record<string, unknown>;
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).sort().join(',') !== 'facts,last,why') return `events[${n}].brief fields are not why,last,facts`;
      if (!oneLine(b.why, EVENT_LIMITS.line)) return `events[${n}].brief.why is not one line of 1 to 60 characters`;
      if (!oneLine(b.last, EVENT_LIMITS.line)) return `events[${n}].brief.last is not one line of 1 to 60 characters`;
      if (!Array.isArray(b.facts) || b.facts.length < EVENT_LIMITS.factsMin || b.facts.length > EVENT_LIMITS.factsMax) return `events[${n}].brief.facts is not 1 to 4 lines`;
      for (const [i, f] of b.facts.entries()) if (!oneLine(f, EVENT_LIMITS.line)) return `events[${n}].brief.facts[${i}] is not one line of 1 to 60 characters`;
    }
  }
  return null;
}

/** A JSON file's text: two-space indent, final newline. */
export function jsonText(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}
