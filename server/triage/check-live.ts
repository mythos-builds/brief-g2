// Live check (run by the CEO, with the key; never by the tests):
//   cd app/server && OPENROUTER_API_KEY=… node triage/check-live.ts [--dataset <path>] [--injection]
// Runs the dataset's 7 mails + 3 Telegram messages through triage(), one at a time.
// Hard cap: 20 requests per run (the key has 50 free requests a day). Each raw answer is
// saved under triage/.cache/ (ignored by git). Exit 0 only if every needs_reply equals the
// dataset's needs_answer, every answer is valid, and exactly 3 items need a reply (2 mail + 1 TG).
// --cache-dir <abs dir> saves the raw answers there instead (offline rehearsal).
// --injection adds the fixture injection mail as an 11th item (expected: no reply; 1 more request).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { triage, TriageError, LIMITS } from './index.ts';
import type { Attempt, Item, RequestBudget, TriageResult } from './index.ts';

const MAX_REQUESTS = 20;
const HERE = new URL('./', import.meta.url);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error('check-live: OPENROUTER_API_KEY is not set. Run: OPENROUTER_API_KEY=<key> node triage/check-live.ts');
  process.exit(2);
}

const datasetPath = arg('--dataset') ?? fileURLToPath(new URL('../../../demo/dataset.json', HERE));
const data = JSON.parse(readFileSync(datasetPath, 'utf8')) as {
  personas: Record<string, { name?: string }>;
  mail: Array<Record<string, unknown>>;
  telegram: Array<Record<string, unknown>>;
};

type Row = { id: string; source: 'mail' | 'tg'; expected: boolean; item: Item };
const nameOf = (key: unknown): string => data.personas[String(key)]?.name ?? String(key);

const rows: Row[] = [];
data.mail.forEach((m, i) => rows.push({
  id: `mail-${i + 1}`, source: 'mail', expected: m.needs_answer === true,
  item: { from: String(m.from), fromName: nameOf(m.from), at: m.at as string | undefined, subject: String(m.subject ?? ''), body: m.body as string | undefined },
}));
data.telegram.forEach((t, i) => rows.push({
  id: `tg-${i + 1}`, source: 'tg', expected: t.needs_answer === true,
  item: { from: String(t.from), fromName: nameOf(t.from), chat: String(t.chat ?? ''), at: t.at as string | undefined, text: String(t.text ?? '') },
}));
if (process.argv.includes('--injection')) {
  const inj = JSON.parse(readFileSync(new URL('./fixtures/injection-mail.json', HERE), 'utf8')) as Item;
  rows.push({ id: 'inject-1', source: 'mail', expected: false, item: inj });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const cacheArg = arg('--cache-dir');
const cacheDir = cacheArg ? new URL(`${stamp}/`, `file://${cacheArg.replace(/\/?$/, '/')}`) : new URL(`./.cache/${stamp}/`, HERE);
mkdirSync(cacheDir, { recursive: true });

const budget: RequestBudget = { left: MAX_REQUESTS };
let failures = 0;
const needCount = { mail: 0, tg: 0 };

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
console.log([pad('id', 9), pad('expect', 6), pad('got', 6), pad('provider', 46), pad('ms', 6), pad('words', 5), 'longest-alt', ' note'].join(' '));

for (const row of rows) {
  let n = 0;
  const onAttempt = (a: Attempt): void => {
    n += 1;
    const file = `${row.id}-${n}-${a.model.replace(/[^A-Za-z0-9.-]+/g, '_')}.json`;
    writeFileSync(new URL(file, cacheDir), JSON.stringify({ id: row.id, model: a.model, status: a.status, ms: a.ms, outcome: a.outcome, reason: a.reason, raw: a.raw }, null, 2));
  };
  const t0 = Date.now();
  let result: TriageResult | null = null;
  let note = '';
  try {
    result = await triage(row.item, { budget, onAttempt });
  } catch (e) {
    note = e instanceof TriageError ? `${e.code}: ${e.message}` : `error: ${(e as Error).message}`;
  }
  const ms = Date.now() - t0;
  if (result === null) {
    failures += 1;
    console.log([pad(row.id, 9), pad(String(row.expected), 6), pad('-', 6), pad('-', 46), pad(String(ms), 6), pad('-', 5), pad('-', 11), ` FAIL ${note}`].join(' '));
    continue;
  }
  const words = result.summary.trim().split(/\s+/).length;
  const longest = result.alts.reduce((m, a) => Math.max(m, a.length), 0);
  const match = result.needs_reply === row.expected;
  if (!match) failures += 1;
  if (result.needs_reply && row.id.startsWith('mail-')) needCount.mail += 1;
  if (result.needs_reply && row.id.startsWith('tg-')) needCount.tg += 1;
  note = match ? '' : ' MISMATCH';
  if (n > 1) note += ` (${n} requests)`;
  console.log([pad(row.id, 9), pad(String(row.expected), 6), pad(String(result.needs_reply), 6), pad(result.provider, 46), pad(String(ms), 6), pad(String(words), 5), pad(String(longest), 11), note].join(' '));
}

const total = needCount.mail + needCount.tg;
const used = MAX_REQUESTS - budget.left;
console.log(`\nneed a reply: ${total} (${needCount.mail} mail + ${needCount.tg} TG), expected 3 (2 mail + 1 TG)`);
console.log(`requests used: ${used} / cap ${MAX_REQUESTS} · limits: summary <= ${LIMITS.summaryWords} words, alt <= ${LIMITS.altChars} chars`);
console.log(`raw answers: ${fileURLToPath(cacheDir)}`);
const pass = failures === 0 && needCount.mail === 2 && needCount.tg === 1;
console.log(pass ? 'PASS' : `FAIL (${failures} item(s) failed or mismatched)`);
process.exit(pass ? 0 : 1);
