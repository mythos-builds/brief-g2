// D2 review (reports/D2-review.md), finding 5, server half: safeText uses the app's rule list (src/logic/reply-rules.ts).
// Before the fix the server let an en-dash or em-dash phone number through and refused private-use characters only in the app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeText } from './validate.ts';

test('finding 5: phone numbers with en or em dashes and private-use characters are refused', () => {
  for (const s of ['Call 514–555–0199 today.', 'Call 514—555—0199 today.', 'Private  sign.']) {
    assert.equal(safeText(s, false).ok, false, s);
  }
  assert.equal(safeText('Room 12 at 3 pm works.', false).ok, true);
});
