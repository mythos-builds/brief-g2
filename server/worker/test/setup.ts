import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeEach, vi } from 'vitest'

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

beforeEach(async () => {
  await env.DB.batch(
    ['sessions', 'handled', 'pair_codes', 'pair_failures', 'oauth_states', 'accounts', 'counters'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  )
  // No network in tests: any real fetch fails the test. The Google calls go through a stub passed as Deps.
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('network call in a test')
  })
})
