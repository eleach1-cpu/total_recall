'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../lib/args');

test('parses cmd, flags with values, boolean flags, positional', () => {
  const a = parseArgs(['search', 'tax math', '--kind', 'turn,statement', '--deep', '--limit', '3']);
  assert.equal(a.cmd, 'search');
  assert.deepEqual(a.positional, ['tax math']);
  assert.equal(a.flags.kind, 'turn,statement');
  assert.equal(a.flags.deep, true);
  assert.equal(a.flags.limit, '3');
});

test('a flag followed by another flag is boolean', () => {
  const a = parseArgs(['gate', '--check', '--session', 'abc']);
  assert.equal(a.cmd, 'gate');
  assert.equal(a.flags.check, true);
  assert.equal(a.flags.session, 'abc');
});

test('no args gives null cmd', () => {
  assert.equal(parseArgs([]).cmd, null);
});
