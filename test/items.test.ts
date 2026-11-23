import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadDataset } from './helpers.ts'
import { briefDue, buildItems, countItems, homeLabel, needLine, nextEvent, validAlts } from '../src/logic/items.ts'
import { readConfig, SOURCES } from '../src/config.ts'
import { STATIC_ALTS } from '../src/data/static-alts.ts'

const ds = loadDataset()

test('the app copy of the dataset is byte-identical to demo/dataset.json (in the repo)', () => {
  const original = readFileSync(new URL('../demo/dataset.json', import.meta.url))
  const copy = readFileSync(new URL('../src/data/dataset.json', import.meta.url))
  assert.ok(original.equals(copy))
})

test('SOURCES defaults to mail only', () => {
  assert.deepEqual([...SOURCES], ['mail'])
  assert.deepEqual(readConfig('').sources, ['mail'])
})

test('readConfig: telegram on, unknown sources ignored, bad clock ignored', () => {
  assert.deepEqual(readConfig('?sources=mail,telegram').sources, ['mail', 'telegram'])
  assert.deepEqual(readConfig('?sources=mail,fax').sources, ['mail'])
  assert.deepEqual(readConfig('?sources=fax').sources, ['mail'])
  assert.equal(readConfig('?at=13:50').clock, '13:50')
  assert.equal(readConfig('?at=soon').clock, undefined)
})

test('mail only: 2 need you, newsletters / notifications / no-answer mail never listed', () => {
  const items = buildItems(ds, ['mail'])
  assert.deepEqual(
    items.map((i) => i.persona),
    ['marco', 'priya'],
  )
  assert.equal(needLine(items, ['mail']), '2 need you')
  assert.deepEqual(countItems(items), { total: 2, mail: 2, telegram: 0 })
})

test('with telegram: 3 need you · 2 mail · 1 TG, muted chat and plain message left out, newest first', () => {
  const items = buildItems(ds, ['mail', 'telegram'])
  assert.deepEqual(
    items.map((i) => i.id),
    ['tg-0', 'mail-0', 'mail-1'],
  )
  assert.equal(needLine(items, ['mail', 'telegram']), '3 need you · 2 mail · 1 TG')
  assert.match(ds.expected_home_screen ?? '', /^3 need you · 2 mail · 1 TG/)
})

test('home labels: name — summary, TG items tagged', () => {
  const items = buildItems(ds, ['mail', 'telegram'])
  assert.equal(homeLabel(items[0]), 'TG · Sam — truck comes 30 min early, ok?')
  assert.equal(homeLabel(items[1]), 'Marco — can you cover Friday 6 am?')
  for (const i of items) assert.ok(homeLabel(i).length <= 64)
})

test('validAlts keeps ≤ 60 characters, one line, no link, at most 4', () => {
  assert.deepEqual(validAlts(['Yes.', 'x'.repeat(61), 'a\nb', 'see https://x.example', 'No.', 'Later.', 'Why?', 'Extra.']), [
    'Yes.',
    'No.',
    'Later.',
    'Why?',
  ])
  assert.deepEqual(validAlts(undefined), [])
  for (const list of Object.values(STATIC_ALTS)) assert.equal(validAlts(list).length, 4)
})

test('next event and meeting brief timing', () => {
  assert.equal(nextEvent(ds, '12:41'), 'next 14:00 Supplier call')
  assert.equal(nextEvent(ds, '17:00'), undefined)
  assert.equal(briefDue(ds, '12:41'), -1)
  assert.equal(briefDue(ds, '13:50'), 0)
  assert.equal(briefDue(ds, '14:00'), -1)
})
