// fromGmail on hand-built users.messages.get answers (fixtures/gmail-messages.json). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromGmail, fromAddress, sha256Hex, b64Bytes, senderAlias, BODY_MAX } from './gmail.ts';
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

// ---- Day 4: senderAlias and the sandbox rule (BRIEF-D4 3.5) ----
const H = (m: Record<string, unknown>) => (m.payload as { headers: { name: string; value: string }[] }).headers;

test('senderAlias: alias, self and persona for an own alias; every doubt → null', async () => {
  const r = await senderAlias(H(M('plain')), SELF, PERSONAS);
  assert.ok(r);
  assert.equal(r.alias, 'demo+marco@example.com');
  assert.equal(r.self, 'demo@example.com');
  assert.equal(r.persona.key, 'marco');
  const up = await senderAlias(H(M('upper_case')), SELF, PERSONAS);
  if (up) assert.equal(up.alias, up.alias.toLowerCase());
  for (const name of ['stranger', 'other_account', 'unknown_tag', 'no_tag', 'two_from', 'odd_tag', 'second_plus', 'tag_with_space', 'group', 'name_holds_alias']) {
    assert.equal(await senderAlias(H(M(name)), SELF, PERSONAS), null, name);
  }
  assert.equal(await senderAlias([], SELF, PERSONAS), null);
  assert.equal(await senderAlias(H(M('plain')), 'f'.repeat(64), PERSONAS), null);
  assert.equal(await senderAlias(null as never, SELF, PERSONAS), null);
  assert.equal(await senderAlias([{ name: 'From', value: 5 as never }], SELF, PERSONAS), null);
});

test('senderAlias returns a copy of the persona, not the caller\'s object', async () => {
  const r = await senderAlias(H(M('plain')), SELF, PERSONAS);
  assert.ok(r && r.persona !== PERSONAS.find((p) => p.key === 'marco'));
});

// The appended shape of fact 1.8: Content-Transfer-Encoding, Content-Type, Date, From, Message-ID, MIME-Version, Subject, To.
function appended(): Record<string, unknown> {
  const m = M('plain');
  (m.payload as { headers: unknown }).headers = [
    { name: 'Content-Transfer-Encoding', value: '8bit' }, { name: 'Content-Type', value: 'text/plain; charset="UTF-8"' },
    { name: 'Date', value: 'Mon, 23 Nov 2026 11:02:00 -0500' }, { name: 'From', value: '"Marco Bellini" <demo+marco@example.com>' },
    { name: 'Message-ID', value: '<seed-1@example.com>' }, { name: 'MIME-Version', value: '1.0' },
    { name: 'Subject', value: 'Friday 6 am' }, { name: 'To', value: 'demo@example.com' },
  ];
  return m;
}
const withHeader = (m: Record<string, unknown>, name: string): Record<string, unknown> => { H(m).push({ name, value: 'from x.example.net by mx.example.net with SMTP; Mon, 23 Nov 2026 11:02:00 -0500' }); return m; };

test('sandbox rule: the appended shape is accepted; a Received / X-Received header (any case) → null', async () => {
  assert.equal((await fromGmail(appended(), SELF, PERSONAS))?.persona.key, 'marco');
  for (const name of ['Received', 'received', 'X-Received', 'x-received', 'X-RECEIVED']) {
    assert.equal(await fromGmail(withHeader(appended(), name), SELF, PERSONAS), null, name);
  }
});

test('sandbox rule: labelIds with SPAM or TRASH → null; other labels stay accepted', async () => {
  for (const l of ['SPAM', 'TRASH']) {
    const m = appended(); m.labelIds = ['Label_1', l];
    assert.equal(await fromGmail(m, SELF, PERSONAS), null, l);
  }
  const ok = appended(); ok.labelIds = ['Label_1', 'UNREAD', 'INBOX'];
  assert.ok(await fromGmail(ok, SELF, PERSONAS));
});

test('sandbox rule: a mail From the bare account address (our own reply coming back) → null', async () => {
  const m = appended();
  H(m)[3].value = 'demo@example.com';
  assert.equal(await fromGmail(m, SELF, PERSONAS), null);
  H(m)[3].value = '"Demo" <demo@example.com>';
  assert.equal(await fromGmail(m, SELF, PERSONAS), null);
});
