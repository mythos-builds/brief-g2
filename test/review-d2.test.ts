// D2 review (reports/D2-review.md), finding 5: the app and the server refuse a reply by ONE rule list.
// Each case below was measured on both sides before the fix: the first two disagreed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replyProblem } from '../src/logic/replies.ts'
import { safeText } from '../server/triage/validate.ts'

const CASES = [
  'Call 514/555/0199 today.', // was: app PASS, server refused
  'Call 514–555–0199 today.', // was: server PASS, app refused
  'Call 514—555—0199 today.',
  'Call +1 514 555 0199.',
  'Ref 12.34.56 is fine.',
  'Room 12 at 3 pm works.',
  'Mail me at a@b.',
  'See pay.example.com/inv.',
  'Go to www.site now.',
  'Use https://x now.',
  'It costs $5.',
  'This is **big**.',
  'Hidden​space here.',
  'Private  sign.',
  'Yes, Thursday works.',
  'I can cover the 6 am start.',
]

test('finding 5: the app (replyProblem) and the server (safeText) agree on every case', () => {
  for (const s of CASES) {
    const app = replyProblem(s, 'alt') === undefined
    const server = safeText(s, false).ok
    assert.equal(app, server, `${JSON.stringify(s)}: app ${app ? 'PASS' : 'refuses'}, server ${server ? 'PASS' : 'refuses'}`)
  }
})

test('finding 5: a phone number with / or – separators is refused on both sides', () => {
  for (const s of ['Call 514/555/0199 today.', 'Call 514–555–0199 today.']) {
    assert.ok(replyProblem(s, 'draft'), s)
    assert.equal(safeText(s, true).ok, false, s)
  }
})
