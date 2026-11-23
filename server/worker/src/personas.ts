// The bundled persona table and frozen demo calendar (BRIEF-D3 § 3.6), their checks, and the display-time helpers.
// Both JSON files are placeholders written by hand from the dataset; the CEO copies job B's seed output over them.
import calendarFile from './demo-calendar.json'
import personasFile from './personas.json'

export interface Persona {
  key: string
  name: string
  fullName: string
  address: string
  company: string
}

export interface CalendarBrief {
  why: string
  last: string
  facts: string[]
}

export interface CalendarEvent {
  start: string
  title: string
  who: string
  brief?: CalendarBrief
}

export const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const KEY_RE = /^[a-z0-9]{1,32}$/
const LINE_MAX = 60

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function exactKeys(o: Record<string, unknown>, required: string[], optional: string[] = []): string | null {
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) return `unknown key ${k}`
  for (const k of required) if (!(k in o)) return `missing ${k}`
  return null
}

const line = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '' && v.length <= LINE_MAX && !/[\r\n]/.test(v)

/** Problems of a personas file against § 3.6; [] = valid. */
export function checkPersonasFile(v: unknown): string[] {
  if (!isObj(v)) return ['not an object']
  const top = exactKeys(v, ['personas'])
  if (top) return [top]
  if (!Array.isArray(v.personas) || v.personas.length === 0) return ['personas must be a non-empty array']
  const p: string[] = []
  const keys = new Set<string>()
  v.personas.forEach((x: unknown, i: number) => {
    if (!isObj(x)) return p.push(`persona ${i}: not an object`)
    const bad = exactKeys(x, ['key', 'name', 'fullName', 'address', 'company'])
    if (bad) return p.push(`persona ${i}: ${bad}`)
    for (const k of ['key', 'name', 'fullName', 'address', 'company'])
      if (typeof x[k] !== 'string' || (x[k] as string).trim() === '') p.push(`persona ${i}: ${k} not a non-empty string`)
    if (typeof x.key === 'string') {
      if (!KEY_RE.test(x.key)) p.push(`persona ${i}: key must be 1-32 of a-z 0-9`)
      if (keys.has(x.key)) p.push(`persona ${i}: duplicate key`)
      keys.add(x.key)
    }
    // fictional addresses only: an example domain (RFC 2606)
    if (typeof x.address === 'string' && !/^[^@\s]+@([a-z0-9-]+\.)*example\.(com|net|org)$/.test(x.address))
      p.push(`persona ${i}: address is not on an example domain`)
    if (typeof x.name === 'string' && typeof x.fullName === 'string' && !x.fullName.startsWith(x.name))
      p.push(`persona ${i}: name is not the first name of fullName`)
  })
  return p
}

/** Problems of one Event (§ 3.4); [] = valid. */
export function checkEvent(e: unknown, i: number): string[] {
  if (!isObj(e)) return [`event ${i}: not an object`]
  const bad = exactKeys(e, ['start', 'title', 'who'], ['brief'])
  if (bad) return [`event ${i}: ${bad}`]
  const p: string[] = []
  if (typeof e.start !== 'string' || !HHMM_RE.test(e.start)) p.push(`event ${i}: start not HH:MM`)
  if (!line(e.title)) p.push(`event ${i}: title must be one line of 1-60 characters`)
  if (typeof e.who !== 'string' || e.who.length > 120 || /[\r\n]/.test(e.who)) p.push(`event ${i}: who not a line`)
  if ('brief' in e) {
    const b = e.brief
    if (!isObj(b) || exactKeys(b, ['why', 'last', 'facts'])) p.push(`event ${i}: brief must be {why, last, facts}`)
    else {
      if (!line(b.why)) p.push(`event ${i}: brief.why must be one line of 1-60 characters`)
      if (!line(b.last)) p.push(`event ${i}: brief.last must be one line of 1-60 characters`)
      if (!Array.isArray(b.facts) || b.facts.length < 1 || b.facts.length > 4 || !b.facts.every(line))
        p.push(`event ${i}: brief.facts must be 1-4 lines of 1-60 characters`)
    }
  }
  return p
}

/** Problems of a demo-calendar file against § 3.4/3.6; [] = valid. */
export function checkCalendarFile(v: unknown): string[] {
  if (!isObj(v)) return ['not an object']
  const top = exactKeys(v, ['now', 'events'])
  if (top) return [top]
  const p: string[] = []
  if (typeof v.now !== 'string' || !HHMM_RE.test(v.now)) p.push('now not HH:MM')
  if (!Array.isArray(v.events)) return [...p, 'events not an array']
  if (v.events.length > 5) p.push('more than 5 events')
  v.events.forEach((e: unknown, i: number) => p.push(...checkEvent(e, i)))
  const starts = (v.events as Array<{ start?: unknown }>).map((e) => String(e?.start ?? ''))
  if (starts.some((s, i) => i > 0 && s < starts[i - 1]!)) p.push('events not in start order')
  if (typeof v.now === 'string' && starts.some((s) => s <= (v.now as string))) p.push('an event does not start after now')
  return p
}

export const PERSONAS: Persona[] | null =
  checkPersonasFile(personasFile).length === 0 ? (personasFile as { personas: Persona[] }).personas : null

export const DEMO_CALENDAR: { now: string; events: CalendarEvent[] } | null =
  checkCalendarFile(calendarFile).length === 0 ? (calendarFile as { now: string; events: CalendarEvent[] }) : null

export function personaOf(key: string | null | undefined): Persona | undefined {
  return key ? PERSONAS?.find((p) => p.key === key) : undefined
}

export const DEFAULT_TZ = 'America/Toronto'

/** A valid IANA zone from the var DISPLAY_TZ, else the default. */
export function displayTz(v: string | undefined): string {
  const tz = (v ?? '').trim() || DEFAULT_TZ
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return tz
  } catch {
    return DEFAULT_TZ
  }
}

/** "HH:MM" (24 h) of a Unix time in the zone. */
export function hhmm(unix: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(unix * 1000))
  const h = parts.find((x) => x.type === 'hour')?.value ?? '00'
  const m = parts.find((x) => x.type === 'minute')?.value ?? '00'
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
}

/** "YYYY-MM-DD" of a Unix time in the zone (what « today » means for the calendar). */
export function localDate(unix: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(unix * 1000),
  )
}
