// The `brief` Worker entry. Only the default export lives here: workerd treats every named export of the main module
// as an entrypoint, so the router and its helpers live in app.ts, the sync in sync.ts.
import { handle } from './app.ts'
import { type Env, liveDeps } from './env.ts'
import { runSync } from './sync.ts'
import { realModules } from './wiring.ts'

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx, liveDeps)
  },
  // cron */2 * * * * (wrangler.toml): the ONLY place where Google and the model are called for reading (BRIEF-D3 § 1.5).
  // Day 4 (§ 6.3): the run is awaited by the handler itself (« Scheduled Workers have a maximum wall time of 15 minutes
  // per invocation »), not left to ctx.waitUntil, which « can extend execution for up to 30 seconds ».
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runSync(env, liveDeps, realModules)
  },
} satisfies ExportedHandler<Env>
