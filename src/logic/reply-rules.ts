// What a reply (the draft or an « Other answer ») may NEVER contain: ONE list, imported by the app (replies.ts) and
// by the server (server/triage/validate.ts), so the two sides cannot drift (D2 review, finding 5). Checked on the
// NFKC form (fullwidth letters, digits and dots fold to ASCII first). Each side may add rules of its own on top
// (the app: what the G2 can draw; the server: lengths and sentence shape), never remove one of these.
// No dependency: the server imports this file under plain Node.
export const UNSAFE_REPLY: ReadonlyArray<readonly [RegExp, string]> = [
  // NUL, tab, U+0085, U+200B, U+202E, U+2028, private-use, unassigned, lone surrogates
  [/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u, 'control or format character'],
  [/@/, 'address sign'],
  [/(https?:|www\.|:\/\/)/i, 'link'],
  [/[\p{L}\p{N}-]+\.(?:[a-z]{2,24})(?:[/:?#]|\b)/iu, 'bare domain'], // pay.example.com/inv, example.net
  [/[\p{L}\p{N}][\p{L}\p{N}-]*\.\p{L}{2,}(?!\p{L})/u, 'bare domain'], // non-ASCII top-level names too
  // 514 555 0199, (514) 555-0199, 514/555/0199, 514–555–0199, +1 514…: 6 digits, up to 2 separators between two
  [/\p{Nd}(?:[\s.()/\-–—+]{0,2}\p{Nd}){5,}/u, 'run of 6 or more digits'],
  [/\p{Sc}/u, 'currency sign'], // $ € £ ¥ ₿…
  [/[*_#[\]`~<>|\\]/, 'markdown or markup character'],
]

/** The first rule a text breaks, or undefined. */
export function unsafeReply(s: string): string | undefined {
  for (const [re, why] of UNSAFE_REPLY) if (re.test(s)) return why
  return undefined
}
