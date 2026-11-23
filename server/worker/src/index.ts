// The `brief` Worker entry. Only the default export lives here: workerd treats every named export of the main module
// as an entrypoint, so the router and its helpers live in app.ts.
import { handle } from './app.ts'
import { type Env, liveDeps } from './env.ts'

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx, liveDeps)
  },
} satisfies ExportedHandler<Env>
