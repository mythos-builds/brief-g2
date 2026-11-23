import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Local workerd + local D1.
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // Test-only dummies, not secrets.
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url))),
          GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'test-client-secret-not-real',
          TOKEN_KEY: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
          ALLOWED_ACCOUNTS: 'Allowed.Demo@example.com, second@example.net',
          // The app's Item interface (read here, in Node) so test/items.test.ts checks the shape against it.
          ITEM_TYPES_SOURCE: readFileSync(fileURLToPath(new URL('../../src/logic/types.ts', import.meta.url)), 'utf8'),
          // The deploy steps (test/review-d2.test.ts checks the app build line, D2 review finding 2).
          WORKER_README_SOURCE: readFileSync(fileURLToPath(new URL('./README.md', import.meta.url)), 'utf8'),
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
    silent: 'passed-only',
  },
}))
