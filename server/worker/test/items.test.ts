import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import file from '../src/demo-items.json'
import { checkDemoFile, DEMO_ITEMS } from '../src/items'

/** The field names (and optional marks) of `export interface Item { … }` in app/src/logic/types.ts. */
function appItemFields(src: string): string[] {
  const m = /export interface Item \{([\s\S]*?)\n\}/.exec(src)
  if (!m) throw new Error('interface Item not found in app/src/logic/types.ts')
  return m[1]!
    .split('\n')
    .map((l) => /^\s*([A-Za-z]+)(\??):/.exec(l))
    .filter((x): x is RegExpExecArray => x !== null)
    .map((x) => x[1]! + x[2]!)
}

describe('src/demo-items.json', () => {
  it('passes the shape check and is the bundled list', () => {
    expect(checkDemoFile(file)).toEqual([])
    expect(DEMO_ITEMS).toEqual(file.items)
  })

  it('has exactly the fields of the app interface Item (contract § 3.10)', () => {
    const fields = appItemFields(env.ITEM_TYPES_SOURCE)
    expect(fields).toEqual(['id', 'source', 'persona', 'name', 'fullName', 'address', 'chat?', 'at', 'summary', 'draft', 'alts'])
    const required = fields.filter((f) => !f.endsWith('?'))
    for (const it of file.items as Record<string, unknown>[]) {
      for (const f of required) expect(it).toHaveProperty(f)
      for (const k of Object.keys(it)) expect(fields.map((f) => f.replace('?', ''))).toContain(k)
    }
  })

  it('holds the 3 items that need a reply (2 mail + 1 Telegram), 4 alternatives each, fictional addresses only', () => {
    expect(file.items).toHaveLength(3)
    expect(file.items.filter((i) => i.source === 'mail')).toHaveLength(2)
    expect(file.items.filter((i) => i.source === 'telegram')).toHaveLength(1)
    for (const i of file.items) {
      expect(i.alts).toHaveLength(4)
      if (i.source === 'mail') expect(i.address).toMatch(/@[a-z0-9.-]+\.example\.(com|net)$/)
    }
  })

  it('the checker refuses wrong shapes', () => {
    const one = structuredClone(file.items[0]!) as Record<string, unknown>
    const wrap = (it: unknown) => ({ generated_at: '2026-11-23T09:00:00Z', items: [it] })
    expect(checkDemoFile(wrap({ ...one, alts: ['a', 'b', 'c'] }))).not.toEqual([])
    expect(checkDemoFile(wrap({ ...one, extra: 1 }))).not.toEqual([])
    expect(checkDemoFile(wrap({ ...one, source: 'sms' }))).not.toEqual([])
    const { draft: _d, ...noDraft } = one
    expect(checkDemoFile(wrap(noDraft))).not.toEqual([])
    expect(checkDemoFile(wrap({ ...one, id: '../x' }))).not.toEqual([])
    expect(checkDemoFile({ items: [] })).not.toEqual([])
    expect(checkDemoFile({ generated_at: 'x', items: [], more: 1 })).not.toEqual([])
    expect(checkDemoFile(wrap(one))).toEqual([])
  })
})
