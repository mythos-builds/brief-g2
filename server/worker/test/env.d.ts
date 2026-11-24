import type { D1Migration } from 'cloudflare:test'
import type { Env as WorkerEnv } from '../src/env'

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[]
      ITEM_TYPES_SOURCE: string
      WORKER_README_SOURCE: string
      WRANGLER_TOML_SOURCE: string
      WRANGLER_LOCAL_TOML_SOURCE: string
    }
  }
}

export {}
