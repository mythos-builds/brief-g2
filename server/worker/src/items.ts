// The demo items, frozen in a file (BRIEF-D2 § 1.2): the Worker only reads them, never calls a model.
import file from './demo-items.json'

/** EXACTLY the interface `Item` of app/src/logic/types.ts (contract § 3.10). Kept in sync by test/items.test.ts. */
export interface Item {
  id: string
  source: 'mail' | 'telegram'
  persona: string
  name: string
  fullName: string
  address: string
  chat?: string
  at: string
  summary: string
  draft: string
  alts: string[]
}

export interface DemoFile {
  generated_at: string
  items: Item[]
}

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const KEYS = ['id', 'source', 'persona', 'name', 'fullName', 'address', 'chat', 'at', 'summary', 'draft', 'alts']
const REQUIRED = KEYS.filter((k) => k !== 'chat')

/** The problems of a demo-items file against the contract; [] = valid. */
export function checkDemoFile(v: unknown): string[] {
  const p: string[] = []
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['not an object']
  const o = v as Record<string, unknown>
  const top = Object.keys(o).sort().join(',')
  if (top !== 'generated_at,items') p.push(`top-level keys: ${top}`)
  if (typeof o.generated_at !== 'string' || Number.isNaN(Date.parse(o.generated_at))) p.push('generated_at not an ISO time')
  if (!Array.isArray(o.items)) return [...p, 'items not an array']
  const ids = new Set<string>()
  o.items.forEach((it: unknown, i: number) => {
    if (typeof it !== 'object' || it === null || Array.isArray(it)) return p.push(`item ${i}: not an object`)
    const r = it as Record<string, unknown>
    for (const k of Object.keys(r)) if (!KEYS.includes(k)) p.push(`item ${i}: unknown key ${k}`)
    for (const k of REQUIRED) if (!(k in r)) p.push(`item ${i}: missing ${k}`)
    for (const k of REQUIRED.filter((k) => k !== 'alts' && k !== 'source'))
      if (k in r && typeof r[k] !== 'string') p.push(`item ${i}: ${k} not a string`)
    if ('chat' in r && typeof r.chat !== 'string') p.push(`item ${i}: chat not a string`)
    if (r.source !== 'mail' && r.source !== 'telegram') p.push(`item ${i}: bad source`)
    if (!Array.isArray(r.alts) || r.alts.length !== 4 || r.alts.some((a) => typeof a !== 'string' || a.trim() === ''))
      p.push(`item ${i}: alts must be 4 non-empty strings`)
    if (typeof r.draft === 'string' && r.draft.trim() === '') p.push(`item ${i}: empty draft`)
    if (typeof r.id === 'string') {
      if (!ID_RE.test(r.id)) p.push(`item ${i}: id not URL-safe (1-64 of A-Z a-z 0-9 _ -)`)
      if (ids.has(r.id)) p.push(`item ${i}: duplicate id`)
      ids.add(r.id)
    }
  })
  return p
}

const problems = checkDemoFile(file)
/** The bundled items; an invalid file makes every items route answer server_error, never a wrong shape. */
export const DEMO_ITEMS: Item[] | null = problems.length === 0 ? (file as DemoFile).items : null

export function findItem(items: Item[], id: string): Item | undefined {
  return items.find((i) => i.id === id)
}
