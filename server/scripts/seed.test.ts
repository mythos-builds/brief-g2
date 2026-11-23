// Seed tests. No network: every fetch is a fake; the CLI is only run with --dry-run or without a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildItems } from '../../src/logic/items.ts';
import type { Dataset } from '../../src/logic/types.ts';
import type { FetchLike } from '../triage/index.ts';
import { runSeed, rowsOf, checkDemoFile, demoFileText, MAX_REQUESTS } from './seed.ts';

const HERE = new URL('./', import.meta.url);
const SERVER = fileURLToPath(new URL('../', HERE));
const ds = JSON.parse(readFileSync(new URL('../../src/data/dataset.json', HERE), 'utf8')) as Dataset;
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/dry-run.json', HERE), 'utf8')) as {
  rows: Record<string, Array<{ status: number; content?: string }>>;
};

/** Per-row replay of the recorded answers, with optional overrides. */
function replayFor(over: Record<string, Array<{ status: number; content?: string }>> = {}) {
  let calls = 0;
  const fetchFor = (rowId: string): FetchLike => {
    const queue = [...(over[rowId] ?? fixtures.rows[rowId] ?? [])];
    return async () => {
      calls += 1;
      const a = queue.shift() ?? { status: 503 };
      const body = a.status === 200 ? JSON.stringify({ choices: [{ message: { content: a.content } }] }) : '{}';
      return { status: a.status, text: async () => body };
    };
  };
  return { fetchFor, calls: () => calls };
}

const KEY = 'test-not-a-key';
const NO_REPLY = '{"needs_reply": false, "summary": "nothing to answer here", "draft": "", "alts": []}';
const REPLY = '{"needs_reply": true, "summary": "please confirm", "draft": "Yes, confirmed.", "alts": ["Yes.", "No.", "Later.", "Why?"]}';

test('rows: the 10 dataset messages, app ids, no dataset label reaches the model', () => {
  const rows = rowsOf(ds);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((r) => r.id), ['mail-0', 'mail-1', 'mail-2', 'mail-3', 'mail-4', 'mail-5', 'mail-6', 'tg-0', 'tg-1', 'tg-2']);
  const allowed = ['from', 'fromName', 'at', 'subject', 'body', 'chat', 'text'];
  for (const r of rows) for (const k of Object.keys(r.item)) assert.ok(allowed.includes(k), `${r.id}.${k}`);
});

test('recorded fixtures: 3 items, identity fields and order exactly as buildItems, triage text in place', async () => {
  const { fetchFor, calls } = replayFor();
  const run = await runSeed(ds, { apiKey: KEY, fetchFor });
  assert.deepEqual(run.problems, []);
  assert.equal(calls(), 12);
  assert.equal(run.requests, 12);
  const app = buildItems(ds, ['mail', 'telegram']);
  assert.deepEqual(run.items.map((i) => i.id), app.map((i) => i.id));
  for (const [n, it] of run.items.entries()) {
    const { summary: _s, draft: _d, alts: _a, ...identity } = it;
    const { summary: _s2, draft: _d2, alts: _a2, ...appIdentity } = app[n];
    assert.deepEqual(identity, appIdentity);
    assert.equal(it.alts.length, 4);
    assert.ok(it.draft.length > 0);
  }
  assert.equal(checkDemoFile(JSON.parse(demoFileText(run.items))), null);
});

test('one item with no valid answer anywhere: nothing to write', async () => {
  const { fetchFor } = replayFor({ 'mail-2': [{ status: 429 }, { status: 503 }, { status: 200, content: 'not json' }] });
  const run = await runSeed(ds, { apiKey: KEY, fetchFor });
  assert.deepEqual(run.items, []);
  assert.match(run.problems.join(' '), /no valid answer for mail-2/);
});

test('a 4th item that needs a reply (Nora): nothing to write', async () => {
  const { fetchFor } = replayFor({ 'tg-1': [{ status: 200, content: REPLY }] });
  const run = await runSeed(ds, { apiKey: KEY, fetchFor });
  assert.deepEqual(run.items, []);
  assert.match(run.problems.join(' '), /4 items need a reply/);
});

test('3 items but not the 3 the app shows: nothing to write', async () => {
  const { fetchFor } = replayFor({ 'tg-1': [{ status: 200, content: REPLY }], 'tg-0': [{ status: 200, content: NO_REPLY }] });
  const run = await runSeed(ds, { apiKey: KEY, fetchFor });
  assert.deepEqual(run.items, []);
  assert.match(run.problems.join(' '), /disagree on tg-0, tg-1/);
});

test('hard cap: every model rate-limited → at most 20 requests in the run', async () => {
  let calls = 0;
  const fetchFor = (): FetchLike => async () => { calls += 1; return { status: 503, text: async () => '{}' }; };
  const run = await runSeed(ds, { apiKey: KEY, fetchFor });
  assert.equal(calls, MAX_REQUESTS);
  assert.ok(run.problems.length > 0);
  assert.match(run.lines.at(-1)?.error ?? '', /^budget_exhausted/);
});

test('checkDemoFile: the shape of BRIEF-D2 § 3.10, nothing more', () => {
  const good = JSON.parse(readFileSync(new URL('../seed/demo-items.dry.json', HERE), 'utf8'));
  assert.equal(checkDemoFile(good), null);
  const clone = () => JSON.parse(JSON.stringify(good));
  const extra = clone(); extra.items[0].text = 'x';
  assert.match(checkDemoFile(extra) ?? '', /extra field text/);
  const three = clone(); three.items[1].alts.pop();
  assert.match(checkDemoFile(three) ?? '', /alts is not 4 strings/);
  const chat = clone(); chat.items.find((i: { source: string }) => i.source === 'mail').chat = 'x';
  assert.match(checkDemoFile(chat) ?? '', /chat does not match/);
  const top = clone(); top.extra = 1;
  assert.match(checkDemoFile(top) ?? '', /top-level keys/);
  const two = clone(); two.items.pop();
  assert.match(checkDemoFile(two) ?? '', /2 items/);
});

test('CLI --dry-run: exit 0, a valid file, no network', () => {
  const r = spawnSync(process.execPath, ['scripts/seed-demo.ts', '--dry-run'], { cwd: SERVER, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /requests used: 12 \/ cap 20/);
  const file = JSON.parse(readFileSync(new URL('../seed/demo-items.dry.json', HERE), 'utf8'));
  assert.equal(checkDemoFile(file), null);
});

test('CLI live without a key: exit 1, clear message, no request', () => {
  const r = spawnSync(process.execPath, ['scripts/seed-demo.ts'], { cwd: SERVER, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /OPENROUTER_API_KEY is not set/);
});

// D2 review, finding 4: the seed runs the app's own reply check (replyProblem) before it writes; a text the server
// accepts but the app would drop (B without « Send », a missing alternative) means nothing is written.
const APP_FIRST = buildItems(ds, ['mail', 'telegram'])[0].id;

test('finding 4: a draft with a line break (server PASS, app refuses) → nothing to write', async () => {
  const draft = '{"needs_reply": true, "summary": "please confirm", "draft": "Yes, confirmed.\\nSee you then.", "alts": ["Yes.", "No.", "Later.", "Why?"]}';
  const { fetchFor } = replayFor({ [APP_FIRST]: [{ status: 200, content: draft }] });
  const run = await runSeed(ds, { apiKey: KEY, fetchFor });
  assert.deepEqual(run.items, []);
  assert.ok(run.problems.some((p) => p.includes(`${APP_FIRST} draft`)), run.problems.join(' | '));
});

test('finding 4: an alternative with a glyph the G2 font lacks (✓) → nothing to write', async () => {
  const alt = '{"needs_reply": true, "summary": "please confirm", "draft": "Yes, confirmed.", "alts": ["✓ Yes.", "No.", "Later.", "Why?"]}';
  const { fetchFor } = replayFor({ [APP_FIRST]: [{ status: 200, content: alt }] });
  const run = await runSeed(ds, { apiKey: KEY, fetchFor });
  assert.deepEqual(run.items, []);
  assert.ok(run.problems.some((p) => p.includes(`${APP_FIRST} alts[0]`)), run.problems.join(' | '));
});
