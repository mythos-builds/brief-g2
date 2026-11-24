// BRIEF-D4.md § 3.12: both production builds (`npm run build` and `VITE_DATA_SOURCE=backend npm run build`) hold the
// dev-only pairing's marker in no file of dist/. The backend build runs first, so dist/ ends as the default build.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MARKER = ['DEV', 'PAIR', 'ONLY'].join('-') // not written whole here, so this file never matches itself
// BRIEF-D5.md § 3.11: the dev-only clip's marker, searched the same way
const VOICE_MARKER = ['DEV', 'VOICE', 'ONLY'].join('-')

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? filesUnder(join(dir, f.name)) : [join(dir, f.name)]))
}

for (const source of ['backend', 'static'] as const) {
  test(`3.12 production build (${source}): no file of dist/ holds the dev pairing nor (D5 § 3.11) the dev clip`, () => {
    const env = { ...process.env }
    delete env.VITE_DATA_SOURCE
    if (source === 'backend') env.VITE_DATA_SOURCE = 'backend'
    execFileSync('npm', ['run', 'build'], { env, stdio: 'pipe' })
    const files = filesUnder('dist')
    assert.ok(files.some((f) => f.endsWith('.js')), 'the build wrote a script')
    const hits = files.filter((f) => readFileSync(f).includes(MARKER) || readFileSync(f).includes(VOICE_MARKER))
    assert.deepEqual(hits, [])
    // and the module's other words are gone too (the branch, not only the comment, was dropped)
    assert.deepEqual(files.filter((f) => f.includes('dev-pair') || readFileSync(f).includes('Paired from the address')), [])
    assert.deepEqual(files.filter((f) => f.includes('dev-voice') || readFileSync(f).includes('samples from the clip')), [])
  })
}
