// The app's switches. SOURCES = which sources feed the « items that need you » list.
import type { Source } from './logic/types.ts'

/** Default: mail only. Telegram joins the same list (tag « TG ») when it is on. */
export const SOURCES: readonly Source[] = ['mail']

export interface Config {
  sources: Source[]
  clock?: string // demo clock "HH:MM"; default = the dataset's `now`
  states: boolean // preview of the F states (static demo only)
}

const KNOWN: readonly Source[] = ['mail', 'telegram']

/**
 * Static demo only: the URL may override the switches, so the screenshot walk can show both settings
 * without a rebuild: `?sources=mail,telegram`, `?at=13:50`, `?states=1`. Unknown values are ignored.
 */
export function readConfig(search: string, defaults: readonly Source[] = SOURCES): Config {
  const q = new URLSearchParams(search)
  const raw = q.get('sources')
  let sources = [...defaults]
  if (raw !== null) {
    const picked = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is Source => (KNOWN as string[]).includes(s))
    if (picked.length) sources = [...new Set(picked)]
  }
  const at = q.get('at') ?? undefined
  const clock = at && /^\d{1,2}:\d{2}$/.test(at) ? at : undefined
  return { sources, clock, states: q.get('states') === '1' }
}
