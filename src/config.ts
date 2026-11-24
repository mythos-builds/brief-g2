// The app's switches. SOURCES = which sources feed the « items that need you » list.
import type { Source } from './logic/types.ts'

/** Default: mail only. Telegram joins the same list (tag « TG ») when it is on. */
export const SOURCES: readonly Source[] = ['mail']

// Build-time switches (Vite replaces `import.meta.env.*` at build; under `node --test` there is no env → defaults).
const env: Record<string, string | boolean | undefined> = import.meta.env ?? {}

export type DataSource = 'static' | 'backend'
/** `static` (default: tests and `npm run shots` stay on the demo data) or `backend` (`VITE_DATA_SOURCE=backend`). */
export const DATA_SOURCE: DataSource = dataSourceOf(env.VITE_DATA_SOURCE)
/** API base: '' = same origin (the Worker serves /app/ and /api/). `VITE_API_BASE=http://127.0.0.1:8787` for local runs. */
export const API_BASE: string = apiBaseOf(env.VITE_API_BASE)
/** Off (default) = demo mode. On (`VITE_REQUIRE_PAIRING=1`): without a paired session the glasses show « Sign-in needed ». */
export const REQUIRE_PAIRING: boolean = env.VITE_REQUIRE_PAIRING === '1' || env.VITE_REQUIRE_PAIRING === 'true'
/** The URL switches below exist on the dev server only (review finding 14): the hosted build ignores the query. */
export const URL_SWITCHES: boolean = env.DEV === true

/** The backend address when `VITE_API_BASE` is not set (the Worker serves /app/ and /api/ on this host). The ONLY place
 * the host is written: the glasses' « Sign-in needed » lines and the phone-side page take it from here. */
export const DEFAULT_HOST = 'brief.appfinishers.com'
/** The backend's host (BRIEF-D4.md § 3.11): `VITE_API_BASE`'s host when set, else DEFAULT_HOST. */
export const BACKEND_HOST: string = backendHostOf(API_BASE)
/** Where the phone signs in: `<host>/connect`, written as plain text (Google refuses sign-in inside the WebView). */
export const CONNECT_ADDRESS: string = `${BACKEND_HOST}/connect`

export function backendHostOf(apiBase: string): string {
  return apiBase ? new URL(apiBase).host : DEFAULT_HOST
}

export function dataSourceOf(v: unknown): DataSource {
  return v === 'backend' ? 'backend' : 'static'
}

export function apiBaseOf(v: unknown): string {
  if (typeof v !== 'string' || v === '') return ''
  return /^https?:\/\/[^/?#]+$/.test(v) ? v : ''
}

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
