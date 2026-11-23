// Day-2 tests for the D1 review findings that sit in server/triage/ (reports/D1-review.md).
// No network: every test injects a fake fetch. Each test names its finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { triage, TriageError, FREE_CHAIN, memoryBudget, memoryCounterStore, dailyBudget, allBudgets } from './index.ts';
import type { FetchLike, Item, RequestBudget, TriageResult } from './index.ts';
import { parseAnswer, LIMITS } from './validate.ts';
import { triageOnce, memoryResultStore } from './once.ts';

const MARCO: Item = { from: 'marco', fromName: 'Marco Bellini', at: '11:02', subject: 'Friday 6 am', body: 'Can you cover the 6 am start on line 1?' };
const KEY = { apiKey: 'test-not-a-key', provider: 'openrouter' };

const ok = (draft: string, alts: string[]) =>
  JSON.stringify({ needs_reply: true, summary: 'cover Friday 6 am?', draft, alts });
const GOOD_ALTS = ['Yes, I can cover Friday.', 'No, I cannot this Friday.', 'Maybe, I will confirm by 3 pm.', 'Which line is it?'];

function answer(content: string): { status: number; body: string } {
  return { status: 200, body: JSON.stringify({ choices: [{ message: { content } }] }) };
}
/** Replays answers in order; counts requests. */
function replay(answers: Array<{ status: number; body: string }>): { fetch: FetchLike; models: string[] } {
  const queue = [...answers];
  const models: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    models.push(JSON.parse(init.body).model);
    const a = queue.shift();
    if (!a) throw new Error('test: more requests than answers');
    return { status: a.status, text: async () => a.body };
  };
  return { fetch, models };
}

// ---- finding 1: async budget, daily counter, triageOnce ----

test('finding 1: the budget is async: an async counter (D1-like) caps requests', async () => {
  let calls = 0;
  const slowCounter: RequestBudget = { take: async () => { await new Promise((r) => setTimeout(r, 1)); calls += 1; return calls <= 1; } };
  const { fetch, models } = replay([{ status: 429, body: '{}' }, { status: 429, body: '{}' }]);
  await assert.rejects(triage(MARCO, { ...KEY, fetch, budget: slowCounter }), (e: unknown) => e instanceof TriageError && e.code === 'budget_exhausted');
  assert.equal(models.length, 1);
});

test('finding 1: daily counter: one store shared by many runs stops at the limit, a new day starts again', async () => {
  const store = memoryCounterStore();
  let clock = Date.parse('2026-11-23T10:00:00Z');
  const daily = dailyBudget(store, 3, () => clock);
  let made = 0;
  const fetch: FetchLike = async () => { made += 1; return { status: 200, text: async () => answer(ok('Yes, I can cover it.', GOOD_ALTS)).body }; };
  for (let i = 0; i < 3; i++) await triage(MARCO, { ...KEY, fetch, budget: daily });
  await assert.rejects(triage(MARCO, { ...KEY, fetch, budget: daily }), (e: unknown) => e instanceof TriageError && e.code === 'budget_exhausted');
  assert.equal(made, 3);
  assert.equal(store.value('triage:2026-11-23'), 3);
  clock = Date.parse('2026-11-24T00:00:01Z');
  await triage(MARCO, { ...KEY, fetch, budget: daily });
  assert.equal(made, 4);
});

test('finding 1: daily counter is atomic: 10 callers at the same moment, limit 4 → exactly 4 pass', async () => {
  const store = memoryCounterStore();
  const daily = dailyBudget(store, 4, () => 0);
  const got = await Promise.all(Array.from({ length: 10 }, () => daily.take()));
  assert.equal(got.filter(Boolean).length, 4);
});

test('finding 1: allBudgets: the per-run cap and the daily cap both apply', async () => {
  const run = memoryBudget(2);
  const daily = dailyBudget(memoryCounterStore(), 10, () => 0);
  const both = allBudgets(run, daily);
  assert.deepEqual([await both.take(), await both.take(), await both.take()], [true, true, false]);
});

test('finding 1: triageOnce: a message already triaged never calls a model again', async () => {
  const store = memoryResultStore();
  const { fetch, models } = replay([answer(ok('Yes, I can cover it.', GOOD_ALTS))]);
  const first = await triageOnce('mail-0', MARCO, store, { ...KEY, fetch });
  const again = await triageOnce('mail-0', MARCO, store, { ...KEY, fetch });
  assert.equal(models.length, 1);
  assert.deepEqual(again, first);
});

test('finding 1: triageOnce: two calls at the same moment for one id = one model call', async () => {
  const store = memoryResultStore();
  const { fetch, models } = replay([answer(ok('Yes, I can cover it.', GOOD_ALTS))]);
  const [a, b] = await Promise.all([triageOnce('mail-0', MARCO, store, { ...KEY, fetch }), triageOnce('mail-0', MARCO, store, { ...KEY, fetch })]);
  assert.equal(models.length, 1);
  assert.deepEqual(a, b);
});

test('finding 1: triageOnce: a stored result is returned with no key and no fetch at all', async () => {
  const store = memoryResultStore();
  const stored: TriageResult = { needs_reply: false, summary: 'parcel out today', draft: '', alts: [], provider: 'openrouter:x' };
  await store.put('mail-5', stored);
  const r = await triageOnce('mail-5', MARCO, store, { provider: 'openrouter', env: { OPENROUTER_API_KEY: '' } });
  assert.deepEqual(r, stored);
});

test('finding 1: triageOnce: a failure stores nothing', async () => {
  const store = memoryResultStore();
  const { fetch } = replay([{ status: 503, body: '{}' }, { status: 503, body: '{}' }, { status: 503, body: '{}' }]);
  await assert.rejects(triageOnce('mail-0', MARCO, store, { ...KEY, fetch }));
  assert.equal(store.size(), 0);
});

// ---- finding 3: what a reply may not contain (each case passed the day-1 checks) ----

const BAD: Array<[string, string]> = [
  ['bare domain', 'Sure, details at pay.example.com/inv.'],
  ['fullwidth www', 'Sure, see ｗｗｗ．ｅｘａｍｐｌｅ．ｃｏｍ today.'],
  ['phone', 'Call me on 514 555 0199.'],
  ['phone with brackets', 'Call (514) 555-0199 now.'],
  ['address', 'Write to ap@example.net.'],
  ['currency', "Yes, I'll wire the $4,800 deposit today."],
  ['euro', 'Yes, 300 € is fine.'],
  ['markdown bold', '**Yes**, see you then.'],
  ['markdown link', 'See [this] please.'],
  ['backtick', 'Use `code` here.'],
  ['RLO', 'Yes, see you‮ then.'],
  ['zero width', 'Yes,​ see you then.'],
  ['line separator', 'Yes, see you then.'],
  ['NEL', 'Yes, see\u0085you then.'],
  ['tab', 'Yes,\tsee you then.'],
  ['NUL', 'Yes,\u0000 see you then.'],
];

for (const [name, text] of BAD) {
  test(`finding 3: refused in an alternative and in the draft: ${name}`, () => {
    const asAlt = parseAnswer(ok('Yes, I can cover it.', [text, ...GOOD_ALTS.slice(1)]));
    assert.equal(asAlt.ok, false, `alt passed: ${name}`);
    const asDraft = parseAnswer(ok(text, GOOD_ALTS));
    assert.equal(asDraft.ok, false, `draft passed: ${name}`);
  });
}

test('finding 3: ordinary replies still pass (times, line numbers, order numbers, apostrophes)', () => {
  const r = parseAnswer(ok("Yes, opening gate 3 at 6:30 works.\nI'll check order S-5521 on line 1.", [
    'Yes, 6:30 works for gate 3.', 'No, please keep the original time.', 'Maybe. I’ll confirm by 3 pm today.', 'Can we confirm the truck’s arrival time?',
  ]));
  assert.equal(r.ok, true, (r as { reason?: string }).reason);
});

test('finding 3: the NFKC form is what is returned (what is checked is what is shown)', () => {
  const r = parseAnswer(ok('Ｙｅｓ, I can cover it.', ['Ｙｅｓ.', ...GOOD_ALTS.slice(1)]));
  assert.ok(r.ok);
  assert.equal(r.value.draft, 'Yes, I can cover it.');
  assert.equal(r.value.alts[0], 'Yes.');
});

// ---- finding 4: errors carry codes and statuses only ----

test('finding 4: no model text, no account id, no V8 parse message in the error or its attempts', async () => {
  const leaky429 = JSON.stringify({ error: { code: 429, metadata: { raw: 'upstream', user_id: 'user_FAKE123' } } });
  const prose = answer('Sure! Marco asked about Friday {not json at all, SECRET-MAIL-TEXT}');
  const { fetch } = replay([{ status: 429, body: leaky429 }, prose, { status: 503, body: 'SECRET-UPSTREAM-BODY' }]);
  await assert.rejects(triage(MARCO, { ...KEY, fetch }), (e: unknown) => {
    assert.ok(e instanceof TriageError);
    assert.equal(e.message, 'all_failed: every model failed (429 invalid 503)');
    const dump = JSON.stringify({ m: e.message, a: e.attempts, s: e.stack });
    for (const leak of ['user_FAKE', 'SECRET', 'Marco', 'Unexpected token', 'JSON at position']) assert.ok(!dump.includes(leak), leak);
    for (const a of e.attempts) assert.equal(a.raw, undefined);
    return true;
  });
});

test('finding 4: a thrown network error message is not kept', async () => {
  const fetch: FetchLike = async () => { throw new Error('connect ECONNREFUSED secret-host.internal:443'); };
  await assert.rejects(triage(MARCO, { ...KEY, fetch, models: ['m1'] }), (e: unknown) => {
    assert.ok(e instanceof TriageError);
    assert.ok(!JSON.stringify({ m: e.message, a: e.attempts }).includes('secret-host'));
    return true;
  });
});

test('finding 4: bad_provider does not echo the value it got', async () => {
  await assert.rejects(triage(MARCO, { provider: 'x-<script>-y' }), (e: unknown) =>
    e instanceof TriageError && e.code === 'bad_provider' && !e.message.includes('script'));
});

test('finding 4: raw bodies reach onAttempt only with debugRaw', async () => {
  const seen: Array<string | undefined> = [];
  const { fetch } = replay([answer(ok('Yes, I can cover it.', GOOD_ALTS)), answer(ok('Yes, I can cover it.', GOOD_ALTS))]);
  await triage(MARCO, { ...KEY, fetch, onAttempt: (a) => seen.push(a.raw) });
  await triage(MARCO, { ...KEY, fetch, debugRaw: true, onAttempt: (a) => seen.push(a.raw) });
  assert.equal(seen[0], undefined);
  assert.ok(seen[1]?.includes('choices'));
});

// ---- finding 6: the draft limit fits 2 wrapped lines ----

test('finding 6: a 125-character draft (3 lines on B after "Draft: ", measured) is invalid', () => {
  const draft = "Hi Priya, thanks for flagging this. I'll arrange for a technician to come by line 2 today before 6 to look at the servo.";
  assert.ok(draft.length > LIMITS.draftChars);
  assert.equal(parseAnswer(ok(draft, GOOD_ALTS)).ok, false);
  assert.ok(LIMITS.draftChars <= 120);
});

// ---- finding 7: skip a 429 model for the rest of the run; one total deadline ----

test('finding 7: after a 429, that model is skipped by the next calls of the run (no wasted request)', async () => {
  const cooldown = new Map<string, number>();
  let clock = 1_000_000;
  const { fetch, models } = replay([
    { status: 429, body: '{"error":{"code":429,"metadata":{"retry_after_seconds":1}}}' },
    answer(ok('Yes, I can cover it.', GOOD_ALTS)),
    answer(ok('Yes, I can cover it.', GOOD_ALTS)),
    answer(ok('Yes, I can cover it.', GOOD_ALTS)),
  ]);
  await triage(MARCO, { ...KEY, fetch, cooldown, now: () => clock });
  await triage(MARCO, { ...KEY, fetch, cooldown, now: () => clock });
  assert.deepEqual(models, [FREE_CHAIN[0], FREE_CHAIN[1], FREE_CHAIN[1]]);
  clock += 61_000; // at least 60 s, even when the body says 1 s
  await triage(MARCO, { ...KEY, fetch, cooldown, now: () => clock });
  assert.equal(models[3], FREE_CHAIN[0]);
});

test('finding 7: one total deadline per call: no new request once it is spent', async () => {
  let clock = 0;
  const models: string[] = [];
  const fetch: FetchLike = async (_u, init) => {
    models.push(JSON.parse(init.body).model);
    clock += 20_000; // each model takes 20 s and fails
    return { status: 503, text: async () => '{}' };
  };
  await assert.rejects(triage(MARCO, { ...KEY, fetch, now: () => clock, deadlineMs: 25_000 }), (e: unknown) => e instanceof TriageError && e.code === 'all_failed');
  assert.equal(models.length, 2); // 0 s → 20 s → 40 s: the third model is never asked
});

// ---- note 9: importing the folder must not load the tests ----

test('note 9: the folder resolves to index.ts for bundlers; main only serves `node --test triage/`', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.module, './index.ts');
  assert.equal(pkg.browser, './index.ts');
  assert.deepEqual(pkg.exports, { '.': './index.ts' });
  assert.match(pkg.main, /\.test\.ts$/);
});
