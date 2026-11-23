// fromGmail on hand-built users.messages.get answers (fixtures/gmail-messages.json). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromGmail, fromAddress, sha256Hex, b64Bytes, BODY_MAX } from './gmail.ts';
import type { Persona } from './gmail.ts';

const FX = JSON.parse(readFileSync(new URL('./fixtures/gmail-messages.json', import.meta.url), 'utf8')) as { messages: Record<string, Record<string, unknown>> };
const M = (name: string): Record<string, unknown> => structuredClone(FX.messages[name]);
const PERSONAS: Persona[] = JSON.parse(readFileSync(new URL('../seed/personas.json', import.meta.url), 'utf8')).personas;
const SELF = await sha256Hex('demo@example.com');

test('plain text: persona mail, ids, Unix seconds, subject, body', async () => {
  const r = await fromGmail(M('plain'), SELF, PERSONAS);
  assert.ok(r);
  assert.equal(r.id, '18c0000000000001');
  assert.equal(r.threadId, '18c0000000000001');
  assert.equal(r.receivedAt, 1795452120);
  assert.equal(r.persona.key, 'marco');
  assert.equal(r.persona.address, 'marco.bellini@northline-automation.example.com');
  assert.deepEqual(Object.keys(r.item).sort(), ['at', 'body', 'from', 'fromName', 'kind', 'subject']);
  assert.equal(r.item.kind, 'mail');
  assert.equal(r.item.from, 'marco');
  assert.equal(r.item.fromName, 'Marco Bellini');
  assert.equal(r.item.at, '11:02');
  assert.equal(r.item.subject, 'Friday 6 am');
  assert.match(r.item.body ?? '', /^Hi, Kevin is off sick.*Marco é$/);
});

test('base64url with and without padding', async () => {
  const a = await fromGmail(M('plain'), SELF, PERSONAS);
  const b = await fromGmail(M('plain_padded'), SELF, PERSONAS);
  assert.ok(a && b);
  assert.equal(b.item.body, `${a.item.body}!`);
  assert.equal(new TextDecoder().decode(b64Bytes('aGk')!), 'hi');
  assert.equal(new TextDecoder().decode(b64Bytes('aGk=')!), 'hi');
  assert.equal(b64Bytes('a*b'), null);
});

test('multipart/alternative: the text/plain part', async () => {
  const r = await fromGmail(M('alternative'), SELF, PERSONAS);
  assert.equal(r?.item.body, 'Plain part wins.');
});

test('HTML only: tags, scripts and styles removed, entities decoded, attachment ignored', async () => {
  const r = await fromGmail(M('html_only'), SELF, PERSONAS);
  assert.ok(r);
  assert.equal(r.item.body, 'Can you come by today ?\nTom & Jerry');
  assert.doesNotMatch(r.item.body ?? '', /alert|color|</);
});

test('refused senders → null: stranger, alias of another account, unknown tag, no tag', async () => {
  for (const name of ['stranger', 'other_account', 'unknown_tag', 'no_tag']) {
    assert.equal(await fromGmail(M(name), SELF, PERSONAS), null, name);
  }
});

test('a display name holding an alias of the account, with a stranger\'s address → null', async () => {
  assert.equal(await fromGmail(M('name_holds_alias'), SELF, PERSONAS), null);
  assert.equal(await fromGmail(M('name_holds_alias_unquoted'), SELF, PERSONAS), null);
  assert.equal(fromAddress('"demo+marco@example.com" <evil@stranger.example.net>'), 'evil@stranger.example.net');
  assert.equal(fromAddress('demo+marco@example.com <evil@stranger.example.net>'), null);
});

test('two From headers (any case) → null; a group → null', async () => {
  assert.equal(await fromGmail(M('two_from'), SELF, PERSONAS), null);
  assert.equal(await fromGmail(M('group'), SELF, PERSONAS), null);
});

test('a tag with odd characters or a second + → null', async () => {
  for (const name of ['odd_tag', 'second_plus', 'tag_with_space']) {
    assert.equal(await fromGmail(M(name), SELF, PERSONAS), null, name);
  }
});

test('upper-case address and tag are lower-cased before the hash and the persona match', async () => {
  const r = await fromGmail(M('upper_case'), SELF, PERSONAS);
  assert.equal(r?.persona.key, 'marco');
});

test('a body of 2 MB is cut at 4,000 characters', async () => {
  const big = M('plain');
  const text = `${'Line 2 tripped again. '.repeat(100_000)}`; // ~2.2 MB
  const data = Buffer.from(text).toString('base64url');
  assert.ok(data.length > 2_000_000);
  (big.payload as { body: { data: string } }).body.data = data;
  const t0 = Date.now();
  const r = await fromGmail(big, SELF, PERSONAS);
  assert.ok(r);
  assert.ok((r.item.body ?? '').length <= BODY_MAX);
  assert.ok((r.item.body ?? '').length > BODY_MAX - 30);
  assert.ok(Date.now() - t0 < 1000);
});

test('subject cut at 200 characters', async () => {
  const m = M('plain');
  const h = (m.payload as { headers: Array<{ name: string; value: string }> }).headers;
  h.find((x) => x.name === 'Subject')!.value = 'S'.repeat(500);
  const r = await fromGmail(m, SELF, PERSONAS);
  assert.equal(r?.item.subject.length, 200);
});

test('malformed messages never throw: null', async () => {
  const cases: unknown[] = [
    M('no_payload'), M('bad_base64'), null, 'text', 42, [], {},
    { ...M('plain'), id: 'bad id!' }, { ...M('plain'), internalDate: 'yesterday' }, { ...M('plain'), threadId: 7 },
    { ...M('plain'), payload: { headers: 'From: x' } }, { ...M('plain'), payload: { headers: [{ name: 'From' }] } },
    { ...M('plain'), payload: { ...(M('plain').payload as object), parts: 'nope' } },
  ];
  for (const c of cases) assert.equal(await fromGmail(c, SELF, PERSONAS), null);
  assert.equal(await fromGmail(M('plain'), 'not-the-hash', PERSONAS), null);
  assert.equal(await fromGmail(M('plain'), SELF, 'x' as unknown as Persona[]), null);
});

test('a deep or huge part tree → null', async () => {
  let p: Record<string, unknown> = { mimeType: 'text/plain', body: { data: 'aGk' } };
  for (let i = 0; i < 20; i++) p = { mimeType: 'multipart/mixed', parts: [p] };
  const m = M('plain');
  (m.payload as Record<string, unknown>).mimeType = 'multipart/mixed';
  (m.payload as Record<string, unknown>).parts = [p];
  (m.payload as Record<string, unknown>).body = {};
  assert.equal(await fromGmail(m, SELF, PERSONAS), null);
});
