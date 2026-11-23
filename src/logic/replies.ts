// What a reply (the draft, or one of the « Other answers ») must be before it reaches B, D″ or C.
// Review findings 3 and 6 (reports/D1-review.md): what the user approves on the glasses must be exactly what is sent,
// so a text is REFUSED (never repaired) when the glasses could not show all of it, when it could hide another text,
// or when it carries something a reply from Brief never carries (a link, an address, a long number, money, markup).
// The refused classes are ONE list shared with the server (reply-rules.ts, D2 review finding 5); the app adds what
// only it can check (whitespace, NFKC, the G2 font, the width) because it only trusts what it can draw.
import { LIST_ITEM_PAD, SCREEN_W, missingGlyphs, textWidth, wrap } from './measure.ts'
import { unsafeReply } from './reply-rules.ts'

export const ALT_MAX_CHARS = 60
/** B: `Draft: …` gets at most 2 wrapped lines (From + summary + 2 = the 4-line rule; C: To + address + 2). */
export const DRAFT_MAX_LINES = 2
export const DRAFT_PREFIX = 'Draft: '
const TEXT_INNER = SCREEN_W - 2 * 4 // a full-width text box, 4 px padding a side (pages.ts TEXT_PAD)
/** D″: one list row, full width, 12 px item padding a side = 552 px. */
export const ALT_MAX_PX = SCREEN_W - 2 * LIST_ITEM_PAD

/** Why a reply text is refused, or undefined when it may be shown and sent as is. */
export function replyProblem(s: string, kind: 'draft' | 'alt'): string | undefined {
  if (s.length === 0) return 'empty'
  if (s !== s.trim()) return 'leading or trailing space'
  if (s !== s.normalize('NFKC')) return 'changes under NFKC'
  if (/[^\S ]/u.test(s)) return 'whitespace other than a space'
  const unsafe = unsafeReply(s)
  if (unsafe) return unsafe
  if (/\S{40,}/u.test(s)) return 'a word of 40 or more characters'
  if (missingGlyphs(s).length) return 'a character the G2 font cannot draw'
  if (kind === 'alt') {
    if (s.length > ALT_MAX_CHARS) return `over ${ALT_MAX_CHARS} characters`
    if (textWidth(s) > ALT_MAX_PX) return `over ${ALT_MAX_PX} px`
  } else if (wrap(DRAFT_PREFIX + s, TEXT_INNER).lineCount > DRAFT_MAX_LINES) return `over ${DRAFT_MAX_LINES} lines`
  return undefined
}

export const isSafeReply = (s: string, kind: 'draft' | 'alt'): boolean => replyProblem(s, kind) === undefined
