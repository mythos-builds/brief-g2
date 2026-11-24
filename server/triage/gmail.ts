// fromGmail(msg, selfHash, personas): a Gmail users.messages.get (format=full) answer → a persona mail, or null.
// Worker-safe (no Node API: crypto.subtle, atob, TextDecoder). It never throws: any doubt → null.
// Fields used, from Google's reference (developers.google.com/gmail/api/reference/rest/v1/users.messages, read
// 2026-11-23): Message.id « The immutable ID of the message. » · Message.threadId « The ID of the thread the message
// belongs to. » · Message.internalDate « The internal message creation timestamp (epoch ms) » (a string) ·
// Message.payload « The parsed email structure in the message parts. » · MessagePart.mimeType, .filename (« Only
// present if this message part represents an attachment. »), .headers (name « before the : separator », value
// « after »), .body, .parts (« The child MIME message parts of this part. »). MessagePartBody.data, from
// …/users.messages.attachments (same day): « The body data of a MIME message part as a base64url encoded string. »
// (the same field also says « A base64-encoded string. »): read as base64url, padded or not, standard alphabet tolerated.
import type { MailItem } from './types.ts';

export interface Persona { key: string; name: string; fullName: string; address: string; company: string }
export interface SeenMail { id: string; threadId: string; persona: Persona; receivedAt: number; item: MailItem }

export const BODY_MAX = 4000;
export const SUBJECT_MAX = 200;
const MAX_PARTS = 100;
const MAX_DEPTH = 8;
/** Base64 characters decoded at most: enough for BODY_MAX characters of text (4 bytes each), more for HTML. */
const PLAIN_B64_MAX = 24_000;
const HTML_B64_MAX = 400_000;

type Part = { mimeType?: unknown; filename?: unknown; headers?: unknown; body?: { data?: unknown }; parts?: unknown };
type Header = { name: string; value: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function headersOf(part: Part): Header[] | null {
  if (!Array.isArray(part.headers)) return null;
  const out: Header[] = [];
  for (const h of part.headers) {
    if (!isObj(h) || typeof h.name !== 'string' || typeof h.value !== 'string') return null;
    out.push({ name: h.name, value: h.value });
  }
  return out;
}

/** SHA-256 hex of a text (UTF-8). */
export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The single address of a From value, lower-cased, or null. Quoted display names are removed first, so an
 * address written inside the name never counts; a name outside quotes may not hold '@', '<' or '>'.
 * Groups, lists, comments, encoded or odd characters in the address → null.
 */
export function fromAddress(value: string): string | null {
  if (value.length > 998 || /[\r\n\0]/.test(value)) return null;
  let rest = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') {
      let closed = false;
      for (i++; i < value.length; i++) {
        if (value[i] === '\\') { i++; continue; }
        if (value[i] === '"') { closed = true; break; }
      }
      if (!closed) return null;
      rest += ' ';
      continue;
    }
    rest += c;
  }
  if (/[(),;:]/.test(rest)) return null; // comments, lists, groups
  let addr: string;
  const open = rest.indexOf('<');
  if (open === -1) {
    if (rest.includes('>')) return null;
    addr = rest.trim();
  } else {
    const close = rest.indexOf('>', open);
    if (close === -1 || rest.indexOf('<', open + 1) !== -1 || rest.indexOf('>', close + 1) !== -1) return null;
    const name = rest.slice(0, open);
    if (name.includes('@') || rest.slice(close + 1).trim() !== '') return null;
    addr = rest.slice(open + 1, close).trim();
  }
  addr = addr.toLowerCase();
  if (!/^[a-z0-9._+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(addr) || addr.length > 254) return null;
  return addr;
}

/** "user+tag@domain" → { base: "user@domain", tag: "tag" }; no tag, an empty one or a second '+' → null. */
export function splitTag(addr: string): { base: string; tag: string } | null {
  const at = addr.lastIndexOf('@');
  const local = addr.slice(0, at);
  const parts = local.split('+');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
  if (!/^[a-z0-9]{1,32}$/.test(parts[1])) return null;
  return { base: `${parts[0]}${addr.slice(at)}`, tag: parts[1] };
}

/** base64url (or base64), padded or not → bytes; anything else → null. */
export function b64Bytes(data: string): Uint8Array | null {
  const clean = data.replace(/[\r\n]/g, '');
  if (!/^[A-Za-z0-9_+/-]*={0,2}$/.test(clean)) return null;
  let s = clean.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s.length % 4 === 1) return null;
  while (s.length % 4) s += '=';
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function charsetOf(part: Part): string {
  const ct = (headersOf(part) ?? []).find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  const m = /charset\s*=\s*"?([A-Za-z0-9_.:-]+)"?/i.exec(ct);
  return m ? m[1].toLowerCase() : 'utf-8';
}

/** The decoded text of a part's body (only its first `max` base64 characters); null = no data; 'bad' = undecodable. */
function partText(part: Part, max: number): string | null | 'bad' {
  const body = part.body;
  if (body !== undefined && !isObj(body)) return 'bad';
  const data = body?.data;
  if (data === undefined || data === '') return null;
  if (typeof data !== 'string') return 'bad';
  const cut = data.length > max ? data.slice(0, max - (max % 4)) : data;
  const bytes = b64Bytes(cut);
  if (!bytes) return 'bad';
  let dec: TextDecoder;
  try {
    dec = new TextDecoder(charsetOf(part));
  } catch {
    dec = new TextDecoder('utf-8');
  }
  return dec.decode(bytes);
}

/** The first non-attachment part of a type, depth first, within MAX_PARTS / MAX_DEPTH; 'bad' = a malformed tree. */
function findPart(root: Part, type: string): Part | null | 'bad' {
  let seen = 0;
  const walk = (p: Part, depth: number): Part | null | 'bad' => {
    if (!isObj(p) || depth > MAX_DEPTH || ++seen > MAX_PARTS) return 'bad';
    const mime = typeof p.mimeType === 'string' ? p.mimeType.toLowerCase() : '';
    const isFile = typeof p.filename === 'string' && p.filename !== '';
    if (p.parts !== undefined && !Array.isArray(p.parts)) return 'bad';
    if (mime === type && !isFile) return p;
    if (p.parts === undefined) return null;
    for (const c of p.parts) {
      const r = walk(c as Part, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(root, 0);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML → plain text: scripts, styles and comments dropped, tags removed, common entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
    .replace(/<(script|style|head|title)\b[\s\S]*?(<\/\1\s*>|$)/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>?/g, ' ')
    .replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (m, e: string) => {
      const l = e.toLowerCase();
      if (l.startsWith('#x')) return safeCodePoint(parseInt(l.slice(2), 16));
      if (l.startsWith('#')) return safeCodePoint(parseInt(l.slice(1), 10));
      return ENTITIES[l] ?? m;
    });
}

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
}

/** Control characters out (newlines kept), blank runs folded, then cut at `max` code points. */
function tidy(text: string, max: number): string {
  const t = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => (c === '\n' ? '\n' : ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const cps = Array.from(t);
  return cps.length > max ? cps.slice(0, max).join('').trimEnd() : t;
}

/** RFC 2047 encoded words (=?utf-8?B?…?= / Q), when a header still carries them; unknown charsets left as is. */
export function decodeWords(v: string): string {
  return v.replace(/=\?([A-Za-z0-9_-]+)\?([BbQq])\?([^?\s]*)\?=/g, (m, cs: string, enc: string, txt: string) => {
    let bytes: Uint8Array | null;
    if (enc.toUpperCase() === 'B') bytes = b64Bytes(txt);
    else {
      const s = txt.replace(/_/g, ' ');
      const arr: number[] = [];
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { arr.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
        else arr.push(s.charCodeAt(i) & 0xff);
      }
      bytes = new Uint8Array(arr);
    }
    if (!bytes) return m;
    try {
      return new TextDecoder(cs.toLowerCase()).decode(bytes);
    } catch {
      return m;
    }
  });
}

/** "HH:MM" as written in the Date header (the sender's clock), else from internalDate in UTC. */
function timeOf(dateHeader: string | undefined, receivedAt: number): string {
  const m = dateHeader ? /\b([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/.exec(dateHeader) : null;
  if (m) return `${m[1]}:${m[2]}`;
  return new Date(receivedAt * 1000).toISOString().slice(11, 16);
}

/**
 * The sender gate, shared by fromGmail and the send: exactly one From header, the strict address parser, tag removed and
 * lower-cased hashing to selfHash, the tag a persona key. alias = local+tag@domain (lower-case), self = local@domain.
 * Any doubt (including a throw) → null. A bare account address (no tag) → null.
 */
export async function senderAlias(
  headers: { name: string; value: string }[],
  selfHash: string,
  personas: Persona[],
): Promise<{ alias: string; self: string; persona: Persona } | null> {
  try {
    if (!Array.isArray(headers) || !Array.isArray(personas) || typeof selfHash !== 'string') return null;
    const froms = headers.filter((h) => isObj(h) && typeof h.name === 'string' && typeof h.value === 'string' && h.name.toLowerCase() === 'from');
    if (froms.length !== 1) return null;
    const addr = fromAddress(froms[0].value);
    if (!addr) return null;
    const split = splitTag(addr);
    if (!split) return null;
    if ((await sha256Hex(split.base)) !== selfHash.toLowerCase()) return null;
    const persona = personas.find((p) => isObj(p) && p.key === split.tag);
    if (!persona) return null;
    return { alias: addr, self: split.base, persona: { ...persona } };
  } catch {
    return null;
  }
}

export async function fromGmail(msg: unknown, selfHash: string, personas: Persona[]): Promise<SeenMail | null> {
  try {
    if (!isObj(msg) || !Array.isArray(personas) || typeof selfHash !== 'string') return null;
    const { id, threadId, internalDate, payload } = msg;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    if (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(threadId)) return null;
    if (typeof internalDate !== 'string' || !/^\d{1,16}$/.test(internalDate)) return null;
    const receivedAt = Math.floor(Number(internalDate) / 1000);
    if (!Number.isSafeInteger(receivedAt) || receivedAt <= 0) return null;
    if (!isObj(payload)) return null;
    const headers = headersOf(payload as Part);
    if (!headers) return null;

    if (Array.isArray((msg as { labelIds?: unknown }).labelIds)) {
      for (const l of (msg as { labelIds: unknown[] }).labelIds) if (l === 'SPAM' || l === 'TRASH') return null;
    }
    // Sandbox rule: only the owner's own IMAP append fills the label (no Received); a mail that travelled over SMTP is not ours.
    if (headers.some((h) => { const n = h.name.toLowerCase(); return n === 'received' || n === 'x-received'; })) return null;
    const who = await senderAlias(headers, selfHash, personas);
    if (!who) return null;
    const persona = who.persona;

    const subjects = headers.filter((h) => h.name.toLowerCase() === 'subject');
    if (subjects.length > 1) return null;
    const subject = tidy(decodeWords(subjects[0]?.value ?? ''), SUBJECT_MAX).replace(/\n/g, ' ');

    const plain = findPart(payload as Part, 'text/plain');
    if (plain === 'bad') return null;
    let body: string | null | 'bad' = plain ? partText(plain, PLAIN_B64_MAX) : null;
    if (body === 'bad') return null;
    if (body === null) {
      const html = findPart(payload as Part, 'text/html');
      if (html === 'bad') return null;
      const h = html ? partText(html, HTML_B64_MAX) : null;
      if (h === 'bad') return null;
      body = h === null ? '' : htmlToText(h);
    }
    body = tidy(body, BODY_MAX);

    const dateHeader = headers.find((h) => h.name.toLowerCase() === 'date')?.value;
    const item: MailItem = { kind: 'mail', from: persona.key, fromName: persona.fullName, at: timeOf(dateHeader, receivedAt), subject, body };
    return { id, threadId, persona, receivedAt, item };
  } catch {
    return null;
  }
}
