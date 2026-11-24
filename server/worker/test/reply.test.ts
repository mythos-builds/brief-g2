// BRIEF-D4 § 3.3: buildReply(), the ONE pure function that writes the reply, with its own tests.
import { describe, expect, it } from 'vitest'
import { sha256hex } from '../src/crypto'
import { buildReply, checkFinished, mailDate, ReplyRefused, replySubject, SIGNATURE } from '../src/send'

const SELF = 'demo@example.com'
const ALIAS = 'demo+marco@example.com'

async function base(over: Partial<Parameters<typeof buildReply>[0]> = {}) {
  return {
    from: SELF,
    to: ALIAS,
    subject: 'Cover Friday 6 am shift?',
    messageId: '<orig-1@example.com>',
    references: '<r1@example.com> <r2@example.com>',
    text: 'Yes, I can cover Friday on line 1.',
    now: 1_795_000_000,
    selfHash: await sha256hex(SELF),
    ...over,
  }
}

/** The finished text → its unfolded headers (name, value) in order and the decoded body. */
export function parseMessage(raw: string): { headers: Array<[string, string]>; body: string; lines: string[] } {
  const end = raw.indexOf('\r\n\r\n')
  const headers = raw
    .slice(0, end)
    .replace(/\r\n[ \t]/g, ' ')
    .split('\r\n')
    .map((l): [string, string] => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()])
  const lines = raw.slice(end + 4).split('\r\n')
  const bytes = Uint8Array.from(atob(lines.join('')), (c) => c.charCodeAt(0))
  return { headers, body: new TextDecoder().decode(bytes), lines }
}

/** RFC 2047 B words (UTF-8) of a header value → its text. */
export function decodeWords(v: string): string {
  return v.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=\s*/g, (_, b: string) =>
    new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))),
  )
}

const header = (raw: string, name: string) => parseMessage(raw).headers.filter(([n]) => n === name).map(([, v]) => v)

describe('buildReply (BRIEF-D4 § 3.3)', () => {
  it('nine headers in the fixed order, one To, the body = the text, an empty line, "-- " and the signature', async () => {
    const raw = await buildReply(await base())
    const m = parseMessage(raw)
    expect(m.headers.map(([n]) => n)).toEqual([
      'From', 'To', 'Subject', 'In-Reply-To', 'References', 'Date', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding',
    ])
    expect(Object.fromEntries(m.headers)).toEqual({
      From: SELF,
      To: ALIAS,
      Subject: 'Re: Cover Friday 6 am shift?',
      'In-Reply-To': '<orig-1@example.com>',
      References: '<r1@example.com> <r2@example.com> <orig-1@example.com>',
      Date: 'Wed, 18 Nov 2026 11:06:40 +0000',
      'MIME-Version': '1.0',
      'Content-Type': 'text/plain; charset=UTF-8',
      'Content-Transfer-Encoding': 'base64',
    })
    expect(m.body).toBe(`Yes, I can cover Friday on line 1.\r\n\r\n-- \r\n${SIGNATURE}`)
    expect(SIGNATURE).toBe('Sent from my glasses with Brief')
    // CRLF line ends only, base64 lines of 76 characters at most
    expect(raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(raw.endsWith('\r\n')).toBe(true)
    for (const l of m.lines.filter((x) => x !== '')) expect(l.length).toBeLessThanOrEqual(76)
    expect(raw).not.toMatch(/^(Cc|Bcc|Reply-To):/im)
  })

  it('a long text gives several 76-character base64 lines', async () => {
    const text = 'Yes, I can cover Friday on line 1. '.repeat(8).trim()
    const m = parseMessage(await buildReply(await base({ text })))
    expect(m.lines.filter((l) => l.length === 76).length).toBeGreaterThan(2)
    expect(m.body.startsWith(text)).toBe(true)
  })

  it('a subject holding \\r\\nBcc: x@evil.example gives NO Bcc header (control characters removed)', async () => {
    const raw = await buildReply(await base({ subject: 'Hello\r\nBcc: x@evil.example' }))
    expect(parseMessage(raw).headers.map(([n]) => n)).not.toContain('Bcc')
    expect(raw).not.toMatch(/\r\nBcc:/i)
    expect(header(raw, 'Subject')).toEqual(['Re: HelloBcc: x@evil.example'])
    expect(replySubject('A\u0000B\u0007C\u007fD\u0085E')).toBe('Re: ABCDE')
  })

  it('a non-ASCII subject → RFC 2047 encoded-words (UTF-8, base64), each 75 characters at most', async () => {
    const raw = await buildReply(await base({ subject: 'Café à 6 h, ça va ? Ünïcödé 日本語' }))
    const [subject] = header(raw, 'Subject')
    expect(subject).toMatch(/^=\?UTF-8\?B\?/)
    expect(decodeWords(subject!)).toBe('Re: Café à 6 h, ça va ? Ünïcödé 日本語')
    // a long one is folded between words: no physical line over 78 characters, nothing outside ASCII
    const long = await buildReply(await base({ subject: '日本語'.repeat(70) }))
    for (const l of long.split('\r\n')) expect(l.length).toBeLessThanOrEqual(78)
    expect(long).toMatch(/^[\x00-\x7f]*$/)
    expect(decodeWords(header(long, 'Subject')[0]!)).toBe(`Re: ${'日本語'.repeat(70).slice(0, 200)}`)
  })

  it('a subject already starting with RE: (any case) gets no second Re:; cut at 200 characters', async () => {
    expect(header(await buildReply(await base({ subject: 'RE: Line 2 tripped' })), 'Subject')).toEqual(['RE: Line 2 tripped'])
    expect(replySubject('re:x')).toBe('re:x')
    expect(replySubject('Fwd: x')).toBe('Re: Fwd: x')
    expect(replySubject('')).toBe('Re:')
    expect(replySubject('a'.repeat(300))).toBe(`Re: ${'a'.repeat(200)}`)
  })

  it('a bad Message-ID → In-Reply-To and References both left out', async () => {
    for (const bad of [null, '', 'orig-1@example.com', '<a b@example.com>', `<${'a'.repeat(241)}>`, '<a<b>', '<a\u0001b@x>', '<ü@x>', '<x> <y>']) {
      const raw = await buildReply(await base({ messageId: bad }))
      const names = parseMessage(raw).headers.map(([n]) => n)
      expect(names).not.toContain('In-Reply-To')
      expect(names).not.toContain('References')
    }
  })

  it('References = the original last 10 good ids + the Message-ID; bad ids are dropped', async () => {
    const ids = Array.from({ length: 14 }, (_, i) => `<id${i}@example.com>`)
    const raw = await buildReply(await base({ references: `${ids.join(' ')} <bad id> junk`, messageId: '<m@example.com>' }))
    expect(header(raw, 'References')).toEqual([[...ids.slice(-10), '<m@example.com>'].join(' ')])
    const none = await buildReply(await base({ references: null }))
    expect(header(none, 'References')).toEqual(['<orig-1@example.com>'])
  })

  it('throws (= a definite failure) on a control character in a header value', async () => {
    await expect(buildReply(await base({ to: `${ALIAS}\r\nBcc: x@evil.example` }))).rejects.toBeInstanceOf(ReplyRefused)
    await expect(buildReply(await base({ from: `${SELF}\u0000` }))).rejects.toBeInstanceOf(ReplyRefused)
  })

  it('throws when To, tag removed and lower-cased, does not hash to the account, or is not ONE alias', async () => {
    await expect(buildReply(await base({ to: 'demo+marco@evil.example' }))).rejects.toThrow('to_hash')
    await expect(buildReply(await base({ to: 'stranger+marco@example.com' }))).rejects.toThrow('to_hash')
    await expect(buildReply(await base({ to: `${ALIAS}, x@evil.example` }))).rejects.toThrow('to')
    await expect(buildReply(await base({ to: SELF }))).rejects.toThrow('to')
    await expect(buildReply(await base({ from: 'other@example.com' }))).rejects.toThrow('from')
    // upper case in the alias is fine: lower-cased before hashing
    expect(header(await buildReply(await base({ to: 'Demo+Marco@Example.com' })), 'To')).toEqual(['Demo+Marco@Example.com'])
  })

  it('the last check refuses a finished text with any other header or a second part', async () => {
    const good = await buildReply(await base())
    const hash = await sha256hex(SELF)
    await expect(checkFinished(good, hash)).resolves.toBeUndefined()
    await expect(checkFinished(good.replace('\r\nDate:', '\r\nBcc: x@evil.example\r\nDate:'), hash)).rejects.toThrow('headers')
    await expect(checkFinished(good.replace('\r\nDate:', '\r\nCc: x@evil.example\r\nDate:'), hash)).rejects.toThrow('headers')
    await expect(checkFinished(`${good}--b\r\nContent-Type: text/html\r\n`, hash)).rejects.toThrow('body')
    await expect(checkFinished(good, await sha256hex('other@example.com'))).rejects.toThrow('to_hash')
  })

  it('Date is RFC 5322 in UTC', () => {
    expect(mailDate(0)).toBe('Thu, 01 Jan 1970 00:00:00 +0000')
  })
})
