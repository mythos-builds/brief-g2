// One list of « items that need you », fed by sources. Pure: no SDK, no DOM, no network.
import type { Dataset, Item, Source } from './types.ts'

export const ALT_MAX_CHARS = 60

/** Keep only alternatives a person could send as is: one line, ≤ 60 characters, no link. At most 4. */
export function validAlts(alts: readonly string[] | undefined): string[] {
  if (!alts) return []
  return alts
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && a.length <= ALT_MAX_CHARS && !/[\r\n]/.test(a) && !/(https?:|www\.)/i.test(a))
    .slice(0, 4)
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s
}

/** "11:02" → minutes since midnight, for ordering and the demo clock. */
export function minutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) throw new Error(`not a time: ${hhmm}`)
  return Number(m[1]) * 60 + Number(m[2])
}

/** "2026-11-24T12:41:00-05:00" → "12:41" (the dataset's local wall clock, no time-zone math). */
export function clockOf(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso)
  if (!m) throw new Error(`no time in ${iso}`)
  return m[1]
}

function mailItems(ds: Dataset, alts: Record<string, string[]>): Item[] {
  const out: Item[] = []
  ds.mail.forEach((m, i) => {
    // newsletters and notifications are never shown, neither is mail that needs no answer
    if (m.hidden || !m.needs_answer) return
    const p = ds.personas[m.from]
    if (!p || !p.email) return
    out.push({
      id: `mail-${i}`,
      source: 'mail',
      persona: m.from,
      name: firstName(p.name),
      fullName: p.name,
      address: p.email,
      at: m.at,
      summary: m.summary6 ?? m.subject,
      draft: m.draft ?? '',
      alts: validAlts(alts[m.from]),
    })
  })
  return out
}

function telegramItems(ds: Dataset, alts: Record<string, string[]>): Item[] {
  const out: Item[] = []
  ds.telegram.forEach((t, i) => {
    // muted chats never; in a group only when the user is mentioned; only what needs an answer
    if (t.muted || !t.needs_answer) return
    if (t.chat !== 'direct' && !t.mentions_user) return
    const p = ds.personas[t.from]
    if (!p) return
    out.push({
      id: `tg-${i}`,
      source: 'telegram',
      persona: t.from,
      name: firstName(p.name),
      fullName: p.name,
      address: t.chat,
      chat: t.chat,
      at: t.at,
      summary: t.summary ?? t.text,
      draft: t.draft ?? '',
      alts: validAlts(alts[t.from]),
    })
  })
  return out
}

/** The items that need you from the enabled sources, newest first (order by need, never by source). */
export function buildItems(ds: Dataset, sources: readonly Source[], alts: Record<string, string[]> = {}): Item[] {
  const all: Item[] = []
  if (sources.includes('mail')) all.push(...mailItems(ds, alts))
  if (sources.includes('telegram')) all.push(...telegramItems(ds, alts))
  return all.sort((a, b) => minutes(b.at) - minutes(a.at))
}

export interface Counts {
  total: number
  mail: number
  telegram: number
}

export function countItems(items: readonly Item[]): Counts {
  const mail = items.filter((i) => i.source === 'mail').length
  const telegram = items.filter((i) => i.source === 'telegram').length
  return { total: items.length, mail, telegram }
}

/** « 2 need you » with one source, « 3 need you · 2 mail · 1 TG » when more than one source is on. */
export function needLine(items: readonly Item[], sources: readonly Source[]): string {
  const c = countItems(items)
  const head = `${c.total} need you`
  if (sources.length < 2) return head
  const parts = [head]
  if (sources.includes('mail')) parts.push(`${c.mail} mail`)
  if (sources.includes('telegram')) parts.push(`${c.telegram} TG`)
  return parts.join(' · ')
}

/** The next calendar event after the clock, as « next 14:00 Supplier call ». */
export function nextEvent(ds: Dataset, clock: string): string | undefined {
  const now = minutes(clock)
  const ev = [...ds.calendar].sort((a, b) => minutes(a.start) - minutes(b.start)).find((e) => minutes(e.start) > now)
  return ev ? `next ${ev.start} ${ev.title}` : undefined
}

/** The meeting brief is due from 10 minutes before an event that has one until it starts. */
export function briefDue(ds: Dataset, clock: string): number {
  const now = minutes(clock)
  return ds.calendar.findIndex((e) => e.brief && now >= minutes(e.start) - 10 && now < minutes(e.start))
}

export function homeLabel(item: Item): string {
  const tag = item.source === 'telegram' ? 'TG · ' : ''
  return `${tag}${item.name} — ${item.summary}`
}

export function summaryLine(item: Item): string {
  return capitalize(item.summary)
}

/** "acme-packaging.example.com" → "Acme Packaging" (fictional demo domains only). */
export function companyOf(email: string | undefined): string | undefined {
  const domain = email?.split('@')[1]
  const label = domain?.split('.')[0]
  if (!label) return undefined
  return label
    .split('-')
    .map((w) => capitalize(w))
    .join(' ')
}
