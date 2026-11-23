// The local fake (§ 3.8): started as its own process on a free port, each path called once, then stopped.
// Only 127.0.0.1 is called. Its answers are checked against job B's own readers (fromGmail, validate, validBrief).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromGmail, sha256Hex } from '../triage/gmail.ts';
import type { Persona } from '../triage/gmail.ts';
import { parseAnswer } from '../triage/validate.ts';
import { validBrief, meetingBrief } from '../triage/brief.ts';
import { triage } from '../triage/index.ts';

const SERVER = fileURLToPath(new URL('../', import.meta.url));
const PERSONAS: Persona[] = JSON.parse(readFileSync(new URL('../seed/personas.json', import.meta.url), 'utf8')).personas;

test('fake-upstreams: every path once, answers usable, /_seen lists method and path, then stopped', async () => {
  const child = spawn(process.execPath, ['scripts/fake-upstreams.ts', '--port', '0'], { cwd: SERVER, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`no listen line: ${out}`)), 5000);
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`exited ${c}: ${out}`)); });
    });
    const form = (o: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

    // POST /token, authorization_code
    let r = await fetch(`${base}/token`, form({ grant_type: 'authorization_code', code: 'good', client_id: 'dev-client-id', redirect_uri: 'http://127.0.0.1:8787/oauth/callback' }));
    assert.equal(r.status, 200);
    const tok = await r.json() as Record<string, unknown>;
    for (const k of ['access_token', 'refresh_token', 'scope', 'expires_in', 'id_token']) assert.ok(k in tok, k);
    const claims = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1], 'base64url').toString());
    assert.equal(claims.email, 'demo@example.com');
    assert.equal(claims.aud, 'dev-client-id');
    assert.equal(claims.iss, 'https://accounts.google.com');
    const auth = { headers: { authorization: `Bearer ${tok.access_token}` } };

    // code `dead`: refresh token `dead`, an access token already expired; refreshing it → 400 invalid_grant
    const deadTok = await (await fetch(`${base}/token`, form({ grant_type: 'authorization_code', code: 'dead' }))).json() as Record<string, unknown>;
    assert.equal(deadTok.refresh_token, 'dead');
    assert.equal((await fetch(`${base}/gmail/v1/users/me/labels`, { headers: { authorization: `Bearer ${deadTok.access_token}` } })).status, 401);
    r = await fetch(`${base}/token`, form({ grant_type: 'refresh_token', refresh_token: 'dead' }));
    assert.equal(r.status, 400);
    assert.equal((await r.json() as { error: string }).error, 'invalid_grant');
    r = await fetch(`${base}/token`, form({ grant_type: 'refresh_token', refresh_token: String(tok.refresh_token) }));
    assert.equal(r.status, 200);
    assert.match(String((await r.json() as { access_token: string }).access_token), /^fake-access\./);

    // POST /revoke
    assert.equal((await fetch(`${base}/revoke`, form({ token: String(tok.refresh_token) }))).status, 200);

    // Gmail: labels → the label id; list with it; get each id
    const labels = await (await fetch(`${base}/gmail/v1/users/me/labels`, auth)).json() as { labels: Array<{ id: string; name: string }> };
    const label = labels.labels.find((l) => l.name === 'brief-demo');
    assert.ok(label);
    const list = await (await fetch(`${base}/gmail/v1/users/me/messages?labelIds=${label.id}&maxResults=20`, auth)).json() as { messages: Array<{ id: string }> };
    assert.equal(list.messages.length, 6);
    const self = await sha256Hex('demo@example.com');
    const kept: string[] = [];
    let ignored = 0;
    for (const { id } of list.messages) {
      const msg = await (await fetch(`${base}/gmail/v1/users/me/messages/${id}?format=full`, auth)).json();
      const seen = await fromGmail(msg, self, PERSONAS);
      if (seen) kept.push(seen.persona.key); else ignored += 1;
    }
    assert.deepEqual(kept.sort(), ['jordan', 'lina', 'marco', 'priya']);
    assert.equal(ignored, 2);
    assert.equal((await fetch(`${base}/gmail/v1/users/me/messages/nope`, auth)).status, 404);

    // Calendar: two events made by the account, guests demo+lina (5 min) and demo+priya (3 h)
    const now = new Date();
    const cal = await (await fetch(`${base}/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${new Date(now.getTime() + 86_400_000).toISOString()}&singleEvents=true&orderBy=startTime&maxResults=5`, auth)).json() as { items: Array<{ summary: string; creator: { self: boolean }; attendees: Array<{ email: string }> }> };
    assert.deepEqual(cal.items.map((e) => e.attendees[1].email), ['demo+lina@example.com', 'demo+priya@example.com']);
    assert.ok(cal.items.every((e) => e.creator.self === true));

    // The model, through job B's own triage and brief (baseUrl = the fake): valid answers
    const opts = { provider: 'openrouter', apiKey: 'fake-not-a-key', baseUrl: base, models: ['fake-model'] };
    const marco = await triage({ from: 'marco', fromName: 'Marco Bellini', subject: 'Friday 6 am', body: 'Can you cover?' }, opts);
    assert.equal(marco.needs_reply, true);
    assert.equal(parseAnswer(JSON.stringify(marco)).ok, true);
    const jordan = await triage({ from: 'jordan', fromName: 'Jordan Blake', subject: 'Order S-5521 shipped', body: 'Shipped.' }, opts);
    assert.equal(jordan.needs_reply, false);
    const lina = PERSONAS.find((p) => p.key === 'lina')!;
    const brief = await meetingBrief({ title: 'Supplier call', start: '14:00', persona: lina, mails: [{ from: 'lina', subject: 'Carton order #4471, new date', body: 'Hi, the carton order #4471 is delayed again, the corrugator is down. New ship date Thursday. We can talk at 2 pm as planned. Lina' }] }, opts);
    assert.ok(validBrief(brief));

    // /_seen: method and path only (no query string)
    const seen = await (await fetch(`${base}/_seen`)).json() as { seen: Array<{ method: string; path: string }> };
    const paths = new Set(seen.seen.map((s) => `${s.method} ${s.path}`));
    for (const p of ['POST /token', 'POST /revoke', 'GET /gmail/v1/users/me/labels', 'GET /gmail/v1/users/me/messages', 'GET /calendar/v3/calendars/primary/events', 'POST /api/v1/chat/completions']) assert.ok(paths.has(p), p);
    assert.ok(seen.seen.every((s) => !s.path.includes('?') && Object.keys(s).join(',') === 'method,path'));
    assert.equal((await fetch(`${base}/elsewhere`)).status, 404);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => (child.exitCode !== null ? resolve(null) : child.once('exit', resolve)));
  }
});
