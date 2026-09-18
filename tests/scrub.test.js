'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scrub } = require('../lib/scrub');

test('known token shapes are replaced', () => {
  const s = scrub('use sk-abcdefghijklmnopqrstuvwxyz123456 and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 and xoxb-1234567890-abc and AKIAABCDEFGHIJKLMNOP');
  assert.equal((s.match(/\[scrubbed\]/g) || []).length, 4);
  assert.doesNotMatch(s, /sk-abc|ghp_ABC|xoxb-1234|AKIAABC/);
});

test('bearer tokens keep the word Bearer', () => {
  assert.equal(scrub('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'), 'Authorization: Bearer [scrubbed]');
});

test('long hex after the word token is replaced, short is kept', () => {
  assert.equal(scrub('token: 0123456789abcdef0123456789abcdef'), 'token: [scrubbed]');
  assert.equal(scrub('token: abc123'), 'token: abc123');
});

test('env assignment lines ending in _KEY/_SECRET/_TOKEN/PASSWORD are masked, others untouched', () => {
  const s = scrub('MAIL_API_KEY=re_live_123\nPORT=3000\nDB_PASSWORD=hunter2\n');
  assert.equal(s, 'MAIL_API_KEY=[scrubbed]\nPORT=3000\nDB_PASSWORD=[scrubbed]\n');
});

test('ordinary prose survives unchanged', () => {
  const p = 'The Tax Math Calculator uses rule 4.25 and the invoice total.';
  assert.equal(scrub(p), p);
});
