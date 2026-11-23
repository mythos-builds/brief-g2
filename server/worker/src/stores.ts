// D1 versions of the triage layer's ResultStore (../triage/once.ts) and CounterStore (../triage/budget.ts).
import type { CounterStore } from '../../triage/budget.ts'
import type { ResultStore } from '../../triage/once.ts'
import type { TriageResult } from '../../triage/types.ts'
import { DAY, endOfDay } from './limits.ts'

/** One row per id in triage_results; put never overwrites an existing id (INSERT … ON CONFLICT DO NOTHING). */
export function d1ResultStore(db: D1Database, now: () => number): ResultStore {
  return {
    async get(id) {
      const row = await db.prepare('SELECT result FROM triage_results WHERE id = ?1').bind(id).first<{ result: string }>()
      if (!row) return null
      try {
        return JSON.parse(row.result) as TriageResult
      } catch {
        return null
      }
    },
    async put(id, result) {
      const clean: TriageResult = {
        needs_reply: result.needs_reply,
        summary: result.summary,
        draft: result.draft,
        alts: [...result.alts],
        provider: result.provider,
      }
      await db
        .prepare('INSERT INTO triage_results (id, result, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING')
        .bind(id, JSON.stringify(clean), now())
        .run()
    },
  }
}

/**
 * incrementBelow on the `counters` table in ONE statement: +1 only while the count is below the limit; a row back =
 * granted, no row = refused. Two callers at the same moment can never both pass the limit. The row lives until the
 * day after (the keys carry their UTC date), then the lazy purge removes it.
 */
export function d1CounterStore(db: D1Database, now: () => number): CounterStore {
  return {
    async incrementBelow(key, limit) {
      if (!(limit > 0)) return false
      const row = await db
        .prepare(
          `INSERT INTO counters (key, count, window_end) VALUES (?1, 1, ?3)
           ON CONFLICT (key) DO UPDATE SET count = counters.count + 1 WHERE counters.count < ?2
           RETURNING count`,
        )
        .bind(key, limit, endOfDay(now()) + DAY)
        .first<{ count: number }>()
      return row !== null
    },
  }
}

/** The current value of a counter (0 when absent): a peek, never an increment. */
export async function counterValue(db: D1Database, key: string): Promise<number> {
  const row = await db.prepare('SELECT count FROM counters WHERE key = ?1').bind(key).first<{ count: number }>()
  return row?.count ?? 0
}
