// BRIEF-D3 § 3.6: the persona table and the frozen demo calendar written by the seed. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Dataset } from '../../src/logic/types.ts';
import { personasOf, demoCalendarOf, checkPersonasFile, checkCalendarFile, DEMO_NOW } from './seed.ts';

const HERE = new URL('./', import.meta.url);
const SERVER = fileURLToPath(new URL('../', HERE));
const ds = JSON.parse(readFileSync(new URL('../../src/data/dataset.json', HERE), 'utf8')) as Dataset;
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../seed/${name}`, HERE), 'utf8'));

test('personas: the dataset personas with an email, first name, fictional address, companyOf', () => {
  const p = personasOf(ds);
  assert.deepEqual(p.map((r) => r.key), ['marco', 'priya', 'jordan', 'lina']);
  assert.deepEqual(p[3], { key: 'lina', name: 'Lina', fullName: 'Lina Chen', address: 'lina.chen@acme-packaging.example.com', company: 'Acme Packaging' });
  assert.equal(checkPersonasFile({ personas: p }), null);
});

test('personas check refuses a bad file', () => {
  const p = personasOf(ds);
  assert.match(checkPersonasFile({ personas: p, x: 1 }) ?? '', /top-level/);
  assert.match(checkPersonasFile({ personas: [{ ...p[0], extra: 1 }] }) ?? '', /fields/);
  assert.match(checkPersonasFile({ personas: [{ ...p[0], address: 'someone@mail.invalid' }] }) ?? '', /fictional/);
  assert.match(checkPersonasFile({ personas: [p[0], p[0]] }) ?? '', /repeated/);
  assert.match(checkPersonasFile({ personas: [{ ...p[0], key: 'Mar co' }] }) ?? '', /plain tag/);
});

test('demo calendar: now 12:41, the two later events in order, who and brief', () => {
  const c = demoCalendarOf(ds);
  assert.equal(c.now, DEMO_NOW);
  assert.deepEqual(c.events.map((e) => [e.start, e.title, e.who]), [
    ['14:00', 'Supplier call', 'Lina Chen, Acme Packaging'],
    ['16:30', 'Site visit, Riverside Foods line 2', 'Priya Nair, Riverside Foods'],
  ]);
  assert.equal(c.events[0].brief?.facts.length, 3);
  assert.equal('brief' in c.events[1], false);
  assert.equal(checkCalendarFile(c), null);
});

test('demo calendar check refuses each break of § 3.4', () => {
  const c = (): { now: string; events: Array<Record<string, unknown>> } => structuredClone(demoCalendarOf(ds)) as never;
  const cases: Array<[(x: ReturnType<typeof c>) => void, RegExp]> = [
    [(x) => { x.now = '12:42'; }, /now/],
    [(x) => { x.events[0].title = 't'.repeat(61); }, /title/],
    [(x) => { x.events[0].start = '11:00'; }, /after now/],
    [(x) => { x.events.reverse(); }, /out of order/],
    [(x) => { x.events[0].extra = 1; }, /extra field/],
    [(x) => { (x.events[0].brief as { facts: string[] }).facts = []; }, /facts/],
    [(x) => { (x.events[0].brief as { why: string }).why = 'w'.repeat(61); }, /why/],
    [(x) => { x.events[1].who = 'a\nb'; }, /who/],
    [(x) => { for (let i = 0; i < 4; i++) x.events.push({ ...x.events[1] }); }, /5 at most/],
  ];
  for (const [mutate, re] of cases) {
    const x = c();
    mutate(x);
    assert.match(checkCalendarFile(x) ?? 'VALID', re);
  }
});

test('CLI --dry-run writes the two files, valid, identical to the functions', () => {
  const r = spawnSync(process.execPath, ['scripts/seed-demo.ts', '--dry-run'], { cwd: SERVER, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS personas\.json/);
  assert.match(r.stdout, /PASS demo-calendar\.json/);
  assert.equal(checkPersonasFile(read('personas.json')), null);
  assert.equal(checkCalendarFile(read('demo-calendar.json')), null);
  assert.deepEqual(read('personas.json'), { personas: personasOf(ds) });
  assert.deepEqual(read('demo-calendar.json'), demoCalendarOf(ds));
});
