// Parse and check a model answer. Limits come from SCREENS.md § A, B, D″ and the D1 brief.
// An answer over a limit is INVALID (the caller tries the next model); text is never cut.

export const LIMITS = {
  summaryWords: 6,
  summaryChars: 64,
  draftLines: 2,
  draftChars: 160,
  altCount: 4,
  altChars: 60,
} as const;

export type Parsed = { needs_reply: boolean; summary: string; draft: string; alts: string[] };
export type Checked = { ok: true; value: Parsed } | { ok: false; reason: string };

/** Keep only the outer {…} of a text that may wrap it in prose or code fences. */
export function extractOuterJson(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

export function wordCount(s: string): number {
  const t = s.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

const LINK = /(https?:\/\/|www\.)/i;

function checkAlt(alt: unknown, i: number): string | null {
  if (typeof alt !== 'string') return `alts[${i}] is not a string`;
  const a = alt.trim();
  if (a === '') return `alts[${i}] is empty`;
  if (/[\r\n]/.test(a)) return `alts[${i}] has more than one line`;
  if (a.length > LIMITS.altChars) return `alts[${i}] is ${a.length} characters (max ${LIMITS.altChars})`;
  if (LINK.test(a)) return `alts[${i}] contains a link`;
  if (!/[.!?]$/.test(a)) return `alts[${i}] is not a complete sentence (no final . ! ?)`;
  if (i === LIMITS.altCount - 1 && !a.endsWith('?')) return `alts[${i}] should be a question`;
  return null;
}

/** Check the parsed object; returns the trimmed value or the first reason it fails. */
export function checkShape(obj: unknown): Checked {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'answer is not a JSON object' };
  const o = obj as Record<string, unknown>;
  if (typeof o.needs_reply !== 'boolean') return { ok: false, reason: 'needs_reply is not a boolean' };
  if (typeof o.summary !== 'string') return { ok: false, reason: 'summary is not a string' };
  const summary = o.summary.trim();
  if (summary === '') return { ok: false, reason: 'summary is empty' };
  if (/[\r\n]/.test(summary)) return { ok: false, reason: 'summary has more than one line' };
  const words = wordCount(summary);
  if (words > LIMITS.summaryWords) return { ok: false, reason: `summary is ${words} words (max ${LIMITS.summaryWords})` };
  if (summary.length > LIMITS.summaryChars) return { ok: false, reason: `summary is ${summary.length} characters (max ${LIMITS.summaryChars})` };

  if (!o.needs_reply) {
    // Nothing to answer: the draft and the alternatives are not used and not returned.
    return { ok: true, value: { needs_reply: false, summary, draft: '', alts: [] } };
  }

  if (typeof o.draft !== 'string') return { ok: false, reason: 'draft is not a string' };
  const draft = o.draft.trim();
  if (draft === '') return { ok: false, reason: 'draft is empty but needs_reply is true' };
  const lines = draft.split(/\r?\n/).length;
  if (lines > LIMITS.draftLines) return { ok: false, reason: `draft is ${lines} lines (max ${LIMITS.draftLines})` };
  if (draft.length > LIMITS.draftChars) return { ok: false, reason: `draft is ${draft.length} characters (max ${LIMITS.draftChars})` };
  if (LINK.test(draft)) return { ok: false, reason: 'draft contains a link' };

  if (!Array.isArray(o.alts)) return { ok: false, reason: 'alts is not an array' };
  if (o.alts.length !== LIMITS.altCount) return { ok: false, reason: `alts has ${o.alts.length} entries (need exactly ${LIMITS.altCount})` };
  for (let i = 0; i < o.alts.length; i++) {
    const err = checkAlt(o.alts[i], i);
    if (err) return { ok: false, reason: err };
  }
  const alts = (o.alts as string[]).map((a) => a.trim());
  return { ok: true, value: { needs_reply: true, summary, draft, alts } };
}

/** From the model's message text to a checked answer. */
export function parseAnswer(content: unknown): Checked {
  if (typeof content !== 'string' || content.trim() === '') return { ok: false, reason: 'empty content' };
  const json = extractOuterJson(content);
  if (json === null) return { ok: false, reason: 'no {…} in content' };
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return { ok: false, reason: `JSON does not parse: ${(e as Error).message}` };
  }
  return checkShape(obj);
}
