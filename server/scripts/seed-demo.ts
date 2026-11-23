// Seed the demo items ONCE (BRIEF-D2 § 5.2). Node 24, no dependency.
//   live (the CEO, with the key):  cd app/server && OPENROUTER_API_KEY=… node scripts/seed-demo.ts
//   dry run (no network, no key):  cd app/server && node scripts/seed-demo.ts --dry-run
// Triages each of the dataset's 10 messages once (hard cap 20 requests per run), prints one line per item,
// and writes seed/demo-items.json (dry run: seed/demo-items.dry.json) ONLY IF every answer is valid and
// exactly 3 items need a reply, the same 3 the app shows. Exit 0 = file written, 1 = nothing written.
// BRIEF-D3 § 3.6: it also writes seed/personas.json and seed/demo-calendar.json (from the dataset only, no model
// call), in --dry-run too, each checked before it is written; an invalid one = nothing written for it, exit 1.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Dataset } from '../../src/logic/types.ts';
import type { FetchLike } from '../triage/index.ts';
import { runSeed, demoFileText, MAX_REQUESTS, personasOf, demoCalendarOf, checkPersonasFile, checkCalendarFile, jsonText } from './seed.ts';

const HERE = new URL('./', import.meta.url);
const dry = process.argv.includes('--dry-run');
const datasetUrl = new URL('../../src/data/dataset.json', HERE); // read only
const outUrl = new URL(dry ? '../seed/demo-items.dry.json' : '../seed/demo-items.json', HERE);

type Answer = { status: number; content?: string };

/** Dry run: each row replays its recorded answers in order; anything else is refused, nothing goes out. */
function fixtureFetch(): (rowId: string) => FetchLike {
  const file = JSON.parse(readFileSync(new URL('./fixtures/dry-run.json', HERE), 'utf8')) as { rows: Record<string, Answer[]> };
  globalThis.fetch = (() => { throw new Error('dry run: no network'); }) as typeof fetch;
  return (rowId) => {
    const queue = [...(file.rows[rowId] ?? [])];
    return async () => {
      const a = queue.shift();
      if (!a) return { status: 503, text: async () => '{}' }; // no recorded answer left = a failed request
      const body = a.status === 200 ? JSON.stringify({ choices: [{ message: { content: a.content } }] }) : '{}';
      return { status: a.status, text: async () => body };
    };
  };
}

let apiKey = process.env.OPENROUTER_API_KEY ?? '';
if (dry) apiKey = 'dry-run-not-a-key';
else if (!apiKey) {
  console.error('seed-demo: OPENROUTER_API_KEY is not set. Live: OPENROUTER_API_KEY=<key> node scripts/seed-demo.ts · offline: --dry-run');
  process.exit(1);
}

const ds = JSON.parse(readFileSync(datasetUrl, 'utf8')) as Dataset;

// The two dataset-only files first: they do not depend on the model.
let fileProblem = false;
for (const [name, obj, check] of [
  ['personas.json', { personas: personasOf(ds) }, checkPersonasFile],
  ['demo-calendar.json', demoCalendarOf(ds), checkCalendarFile],
] as const) {
  const bad = check(obj);
  const url = new URL(`../seed/${name}`, HERE);
  if (bad) {
    fileProblem = true;
    console.log(`FAIL ${name}: ${bad} (not written)`);
  } else {
    writeFileSync(url, jsonText(obj));
    console.log(`PASS ${name} → ${fileURLToPath(url)}`);
  }
}
const run = await runSeed(ds, { apiKey, fetchFor: dry ? fixtureFetch() : undefined, maxRequests: MAX_REQUESTS });

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
console.log([pad('id', 7), pad('expect', 6), pad('got', 6), pad('provider', 46), pad('ms', 6), pad('words', 5), 'longest-alt', ' note'].join(' '));
for (const l of run.lines) {
  const r = l.result;
  if (!r) {
    console.log([pad(l.id, 7), pad(String(l.expected), 6), pad('-', 6), pad('-', 46), pad(String(l.ms), 6), pad('-', 5), pad('-', 11), ` FAIL ${l.error}`].join(' '));
    continue;
  }
  const words = r.summary.trim().split(/\s+/).length;
  const longest = r.alts.reduce((m, a) => Math.max(m, a.length), 0);
  const note = r.needs_reply === l.expected ? '' : ' MISMATCH';
  console.log([pad(l.id, 7), pad(String(l.expected), 6), pad(String(r.needs_reply), 6), pad(r.provider, 46), pad(String(l.ms), 6), pad(String(words), 5), pad(String(longest), 11), note].join(' '));
}
console.log(`\nrequests used: ${run.requests} / cap ${MAX_REQUESTS}${dry ? ' (dry run: recorded fixtures, no network)' : ''}`);

if (run.problems.length) {
  console.log(`FAIL, nothing written: ${run.problems.join(' · ')}`);
  process.exit(1);
}
writeFileSync(outUrl, demoFileText(run.items));
console.log(`PASS: ${run.items.length} items → ${fileURLToPath(outUrl)}`);
if (fileProblem) process.exit(1);
