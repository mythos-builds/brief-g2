import { defineConfig } from 'vite'

// The app is index.html + src/ only. app/server/ (the triage layer and the Worker) is never bundled from here.
// base './' = every asset URL in dist/index.html is relative, so the same dist/ works under /app/ on the Worker
// (brief.appfinishers.com/app/) and at the root of an Even Hub package (app.json `entrypoint: index.html`).
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
