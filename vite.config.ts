import { defineConfig } from 'vite'

// The app is index.html + src/ only. app/server/ (the triage layer) is never bundled from here.
export default defineConfig({
  build: { target: 'es2022' },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
