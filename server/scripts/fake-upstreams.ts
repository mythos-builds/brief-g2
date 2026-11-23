// The local fake of Google and of the model (BRIEF-D3 § 3.8). Node 24, no dependency, 127.0.0.1 only.
//   cd app/server && node scripts/fake-upstreams.ts [--port 8799]      (--port 0 = any free port)
// ONE http server, answers from fixtures; it never calls anything. Dev account demo@example.com, client id
// dev-client-id. The Worker points its five dev vars here (only when ENV is "dev"):
//   GOOGLE_TOKEN_URL=http://127.0.0.1:8799/token   GOOGLE_REVOKE_URL=http://127.0.0.1:8799/revoke
//   GMAIL_BASE=http://127.0.0.1:8799   CALENDAR_BASE=http://127.0.0.1:8799   MODEL_BASE=http://127.0.0.1:8799
// Paths: POST /token · POST /revoke · GET /gmail/v1/users/me/labels · GET /gmail/v1/users/me/messages ·
// GET /gmail/v1/users/me/messages/<id> · GET /calendar/v3/calendars/primary/events · POST /api/v1/chat/completions ·
// GET /_seen (the requests received: method and path only, never a query, a header or a body).
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Dataset } from '../../src/logic/types.ts';

export const DEV_ACCOUNT = 'demo@example.com';
export const DEV_CLIENT_ID = 'dev-client-id';
export const LABEL_NAME = 'brief-demo';
export const LABEL_ID = 'Label_1';
export const SCOPE = 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly';
const BODY_MAX = 1_000_000;

const HERE = new URL('./', import.meta.url);
const ds = JSON.parse(readFileSync(new URL('../../src/data/dataset.json', HERE), 'utf8')) as Dataset;
const recorded = JSON.parse(readFileSync(new URL('./fixtures/dry-run.json', HERE), 'utf8')) as { rows: Record<string, Array<{ status: number; content?: string }>> };

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** Access tokens carry their own expiry (Unix seconds): `fake-access.<exp>.<n>`; stateless across restarts. */
function accessToken(expiresIn: number, n: number, nowS: number): string {
  return `fake-access.${nowS + expiresIn}.${n}`;
}
function tokenAlive(auth: string | undefined, nowS: number): boolean {
  const m = /^Bearer fake-access\.(\d+)\.\d+$/.exec(auth ?? '');
  return !!m && Number(m[1]) > nowS;
}

function idToken(nowS: number): string {
  const head = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: DEV_CLIENT_ID, sub: 'fake-sub-1', email: DEV_ACCOUNT, email_verified: true, iat: nowS, exp: nowS + 3600 }));
  return `${head}.${body}.`;
}

export interface FakeMessage { id: string; threadId: string; labelIds: string[]; internalDate: string; payload: unknown; snippet: string; sizeEstimate: number }

/** `HH:MM` today (the server's UTC day) at America/Toronto standard time (-05:00) → epoch ms. */
function todayAt(hhmm: string, start: Date): number {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), h + 5, m);
}

function message(i: number, from: string, subject: string, body: string, at: string, start: Date): FakeMessage {
  const ms = todayAt(at, start);
  const id = `18c1f00000000${(0x100 + i).toString(16)}`;
  return {
    id, threadId: id, labelIds: [LABEL_ID], internalDate: String(ms), snippet: '', sizeEstimate: body.length + 400,
    payload: {
      partId: '', mimeType: 'text/plain', filename: '',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: DEV_ACCOUNT },
        { name: 'Subject', value: subject },
        { name: 'Date', value: `${new Date(ms - 5 * 3600_000).toUTCString().slice(0, 25)} -0500` },
        { name: 'Message-ID', value: `<fake-${i}@brief-demo.invalid>` },
        { name: 'Content-Type', value: 'text/plain; charset="UTF-8"' },
      ],
      body: { size: body.length, data: b64url(body) },
    },
  };
}

/** The 4 dataset mails from demo+<key>@example.com, one stranger, one alias of another account. */
export function fakeMessages(start: Date): FakeMessage[] {
  const out: FakeMessage[] = [];
  ds.mail.forEach((m, i) => {
    const p = ds.personas[m.from];
    if (!p?.email) return;
    out.push(message(i, `"${p.name}" <demo+${m.from}@example.com>`, m.subject, m.body ?? '', m.at, start));
  });
  out.push(message(20, '"Marco Bellini" <marco@stranger.example.net>', 'Quick question', 'Can you send me the line 1 schedule? Marco', '10:30', start));
  out.push(message(21, '"Lina Chen" <other+lina@example.com>', 'Carton order', 'Hi, a word about the cartons. Lina', '10:45', start));
  return out;
}

/** One event 5 minutes after start with demo+lina, one 3 hours after with demo+priya; both made by the account. */
export function fakeEvents(start: Date): unknown[] {
  const ev = (id: string, at: number, title: string, guest: string) => ({
    kind: 'calendar#event', id, status: 'confirmed', summary: title,
    creator: { email: DEV_ACCOUNT, self: true }, organizer: { email: DEV_ACCOUNT, self: true },
    start: { dateTime: new Date(at).toISOString(), timeZone: 'America/Toronto' },
    end: { dateTime: new Date(at + 30 * 60_000).toISOString(), timeZone: 'America/Toronto' },
    attendees: [{ email: DEV_ACCOUNT, self: true, organizer: true, responseStatus: 'accepted' }, { email: guest, responseStatus: 'needsAction' }],
  });
  const t = start.getTime();
  return [
    ev('fakeevent1lina', t + 5 * 60_000, 'Supplier call', 'demo+lina@example.com'),
    ev('fakeevent2priya', t + 3 * 3600_000, 'Site visit, Riverside Foods line 2', 'demo+priya@example.com'),
  ];
}

/** Recorded, valid brief answers (every number is in that persona's mails). */
export const BRIEFS: Record<string, { why: string; last: string; facts: string[] }> = {
  lina: { why: 'Carton order 4471 is late again', last: 'New ship date Thursday, talk at 2 pm', facts: ['The corrugator is down', 'Order 4471 now ships Thursday'] },
  priya: { why: 'Line 2 keeps tripping on servo overload', last: 'Asked for a visit today, on site until 6', facts: ['Line 2 tripped twice since 7 am', 'They lose 20 minutes per reset'] },
};

const NO_REPLY = '{"needs_reply": false, "summary": "nothing to answer here", "draft": "", "alts": []}';

/** The model's answer for one chat request: triage (recorded dry-run answer of that persona's mail) or brief. */
export function modelAnswer(body: unknown): string {
  const msgs = (body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? [];
  const user = msgs.find((m) => m.role === 'user')?.content;
  const text = typeof user === 'string' ? user : '';
  const json = (open: string, close: string): Record<string, unknown> | null => {
    const a = text.indexOf(open);
    const b = text.lastIndexOf(close);
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(text.slice(a + open.length, b)); } catch { return null; }
  };
  const keyOf = (fullName: unknown): string | undefined => Object.entries(ds.personas).find(([, p]) => p.name === fullName)?.[0];
  const meeting = json('<meeting>', '</meeting>');
  if (meeting) {
    const key = keyOf((meeting.with as { name?: unknown } | undefined)?.name);
    return JSON.stringify(key && BRIEFS[key] ? BRIEFS[key] : { why: 'Meeting today', last: 'See the last mail', facts: ['No detail in the mails'] });
  }
  const item = json('<item>', '</item>');
  const key = keyOf(item?.from);
  const idx = key ? ds.mail.findIndex((m) => m.from === key) : -1;
  const answers = idx >= 0 ? (recorded.rows[`mail-${idx}`] ?? []).filter((a) => a.status === 200 && a.content) : [];
  return answers.length ? (answers[answers.length - 1].content as string) : NO_REPLY;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_MAX) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function params(raw: string, type: string | undefined): Record<string, string> {
  if ((type ?? '').includes('application/json')) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

export function createFake(opts: { start?: Date } = {}): Server & { seen: Array<{ method: string; path: string }> } {
  const start = opts.start ?? new Date();
  const messages = fakeMessages(start);
  const events = fakeEvents(start);
  const seen: Array<{ method: string; path: string }> = [];
  let n = 0;

  const send = (res: ServerResponse, status: number, obj: unknown): void => {
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(s);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (path !== '/_seen') seen.push({ method, path });
    const nowS = Math.floor(Date.now() / 1000);
    try {
      if (method === 'GET' && path === '/_seen') return send(res, 200, { seen });

      if (method === 'POST' && (path === '/token' || path === '/revoke' || path === '/api/v1/chat/completions')) {
        const raw = await readBody(req);
        if (raw === null) return send(res, 413, { error: 'too_large' });
        if (path === '/revoke') return send(res, 200, {});
        if (path === '/token') {
          const p = params(raw, req.headers['content-type']);
          if (p.grant_type === 'authorization_code' && p.code) {
            const dead = p.code === 'dead';
            const expiresIn = dead ? 0 : 3599;
            return send(res, 200, {
              access_token: accessToken(expiresIn, ++n, nowS), expires_in: expiresIn, refresh_token: dead ? 'dead' : `fake-refresh-${n}`,
              scope: SCOPE, token_type: 'Bearer', id_token: idToken(nowS),
            });
          }
          if (p.grant_type === 'refresh_token' && p.refresh_token) {
            if (p.refresh_token === 'dead') return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
            return send(res, 200, { access_token: accessToken(3599, ++n, nowS), expires_in: 3599, scope: SCOPE, token_type: 'Bearer' });
          }
          return send(res, 400, { error: 'invalid_request' });
        }
        // the model: OpenRouter's chat completions shape
        let body: unknown;
        try { body = JSON.parse(raw); } catch { return send(res, 400, { error: { code: 400, message: 'bad json' } }); }
        if (!/^Bearer \S+$/.test(req.headers.authorization ?? '')) return send(res, 401, { error: { code: 401, message: 'no key' } });
        const model = (body as { model?: unknown }).model;
        return send(res, 200, { id: `gen-fake-${++n}`, model: typeof model === 'string' ? model : 'fake', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: modelAnswer(body) } }] });
      }

      if (method === 'GET' && (path.startsWith('/gmail/') || path.startsWith('/calendar/'))) {
        if (!tokenAlive(req.headers.authorization, nowS)) return send(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
        if (path === '/gmail/v1/users/me/labels') {
          return send(res, 200, { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: LABEL_ID, name: LABEL_NAME, type: 'user' }] });
        }
        if (path === '/gmail/v1/users/me/messages') {
          const label = url.searchParams.getAll('labelIds');
          const max = Math.min(Number(url.searchParams.get('maxResults') ?? '100') || 100, 500);
          const list = label.includes(LABEL_ID) ? [...messages].sort((a, b) => Number(b.internalDate) - Number(a.internalDate)).slice(0, max) : [];
          return send(res, 200, list.length ? { messages: list.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: list.length } : { resultSizeEstimate: 0 });
        }
        const mm = /^\/gmail\/v1\/users\/me\/messages\/([A-Za-z0-9_-]{1,64})$/.exec(path);
        if (mm) {
          const m = messages.find((x) => x.id === mm[1]);
          return m ? send(res, 200, m) : send(res, 404, { error: { code: 404, status: 'NOT_FOUND' } });
        }
        if (path === '/calendar/v3/calendars/primary/events') {
          const tMin = Date.parse(url.searchParams.get('timeMin') ?? '') || -Infinity;
          const tMax = Date.parse(url.searchParams.get('timeMax') ?? '') || Infinity;
          const max = Number(url.searchParams.get('maxResults') ?? '250') || 250;
          const items = events.filter((e) => {
            const t = Date.parse((e as { start: { dateTime: string } }).start.dateTime);
            return t >= tMin && t < tMax;
          }).slice(0, max);
          return send(res, 200, { kind: 'calendar#events', summary: DEV_ACCOUNT, timeZone: 'America/Toronto', items });
        }
      }
      return send(res, 404, { error: 'not_found' });
    } catch {
      return send(res, 500, { error: 'server_error' });
    }
  });
  return Object.assign(server, { seen });
}

function portArg(argv: string[]): number {
  const i = argv.indexOf('--port');
  if (i === -1) return 8799;
  const v = Number(argv[i + 1]);
  if (!Number.isInteger(v) || v < 0 || v > 65535) {
    console.error('fake-upstreams: --port needs a number from 0 to 65535');
    process.exit(1);
  }
  return v;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createFake();
  server.listen(portArg(process.argv), '127.0.0.1', () => {
    const a = server.address();
    const port = typeof a === 'object' && a ? a.port : 0;
    console.log(`fake-upstreams listening on http://127.0.0.1:${port}`);
  });
  const stop = (): void => { server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
