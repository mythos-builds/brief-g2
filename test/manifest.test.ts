import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))

test('app.json: id, name, network whitelist brief.appfinishers.com only, no microphone', () => {
  const app = read('../app.json')
  assert.equal(app.package_id, 'com.appfinishers.brief')
  assert.equal(app.name, 'Brief')
  assert.equal(app.min_sdk_version, '0.0.12')
  assert.deepEqual(
    app.permissions.map((p: { name: string }) => p.name),
    ['network'],
  )
  assert.deepEqual(app.permissions[0].whitelist, ['https://brief.appfinishers.com'])
})

test('package.json: every dependency pinned to an exact version', () => {
  const pkg = read('../package.json')
  for (const [name, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }))
    assert.match(String(v), /^\d+\.\d+\.\d+$/, `${name}@${v}`)
})

test('tsconfig and the test glob keep app/server/ (job B) out', () => {
  const ts = read('../tsconfig.json')
  assert.ok(!ts.include.some((p: string) => p.startsWith('server')))
  assert.match(read('../package.json').scripts.test, /"test\/\*\*\/\*\.test\.ts"/)
})
