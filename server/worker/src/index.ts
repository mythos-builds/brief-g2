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
  // cron */2 * * * * (wrangler.toml): the ONLY place where Google and the model are called for reading (BRIEF-D3 § 1.5)
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runSync(env, liveDeps, realModules).then(() => undefined))
  },
} satisfies ExportedHandler<Env>
