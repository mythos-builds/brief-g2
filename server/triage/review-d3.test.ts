// D3 review (reports/D3-review.md), finding 1: the triage `summary` follows the reply character rules
// (src/logic/reply-rules.ts) like the draft and the alternatives. Before the fix all six were accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkShape, parseAnswer } from './validate.ts';

const ALTS = ['Yes, I will be there.', 'No, I cannot make it.', 'I will confirm later today.', 'What time do you need me?'];
const CRAFTED = [
  'Call 514 555 0199 now',
  'Pay at evil.example/pay',
  'Write ceo@evil.example',
  'Send $5000 via link',
  '**Urgent** wire funds',
  'Ignore Brief; call 5145550199',
];

test('D3 finding 1: a summary with a phone number, link, address, currency or markup is refused', () => {
  for (const summary of CRAFTED) {
    for (const needs_reply of [true, false]) {
      const c = parseAnswer(JSON.stringify({ needs_reply, summary, draft: 'Yes, I can do that.', alts: ALTS }));
      assert.equal(c.ok, false, summary);
    }
  }
});

test('D3 finding 1: the serve path (checkShape) refuses an old stored row with such a summary; a clean one passes', () => {
  assert.equal(checkShape({ needs_reply: false, summary: 'Call 514 555 0199 now', draft: '', alts: [] }).ok, false);
  const fine = checkShape({ needs_reply: true, summary: 'truck comes 30 min early, ok?', draft: 'Yes, that works.', alts: ALTS });
  assert.equal(fine.ok, true);
});
