'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TOTAL_RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-gate-'));
const gate = require('../lib/gate');
const { resolveSessionId } = require('../lib/session');

test('session id order: payload, env, flag, none', () => {
  assert.equal(resolveSessionId({ payload: { session_id: 'p' }, env: { CLAUDE_CODE_SESSION_ID: 'e' }, flags: { session: 'f' } }), 'p');
  assert.equal(resolveSessionId({ payload: null, env: { CLAUDE_CODE_SESSION_ID: 'e' }, flags: { session: 'f' } }), 'e');
  assert.equal(resolveSessionId({ payload: null, env: {}, flags: { session: 'f' } }), 'f');
  assert.equal(resolveSessionId({ payload: null, env: {}, flags: {} }), null);
});

test('edit gate blocks before a search and opens after ack', () => {
  const r1 = gate.checkEdit('demo', 'sid1');
  assert.equal(r1.ok, false);
  assert.match(r1.message, /BLOCKED by total_recall: run  total_recall search/);
  gate.ack('demo', 'sid1');
  assert.equal(gate.checkEdit('demo', 'sid1').ok, true);
  gate.arm('demo', 'sid1');
  assert.equal(gate.checkEdit('demo', 'sid1').ok, false);
});

test('a session id of null blocks and says so', () => {
  const r = gate.checkEdit('demo', null);
  assert.equal(r.ok, false);
  assert.match(r.message, /no session id/);
});

test('bash gate blocks write-shaped commands and passes reads', () => {
  const root = 'C:/proj';
  const blocked = ['git commit -m x', 'sed -i "s/a/b/" src/a.js', 'echo hi > notes.md', 'cat a >> src/b.js',
    'cp a.txt src/b.txt', 'mv a.txt C:/proj/b.txt', 'node -e "require(\'fs\').writeFileSync(\'x\',1)"',
    'python -c "open(\'x\',\'w\').write(\'y\')"', 'Set-Content -Path a.txt -Value b', 'tee src/out.js'];
  for (const c of blocked) assert.equal(gate.checkBash('demo', 'sid2', c, root).ok, false, c);
  const passed = ['git status', 'ls -la', 'grep -n foo src/a.js', 'node --test tests/', 'echo hi > /tmp/scratch.txt', 'cp a.txt /tmp/b.txt'];
  for (const c of passed) assert.equal(gate.checkBash('demo', 'sid2', c, root).ok, true, c);
  gate.ack('demo', 'sid2');
  assert.equal(gate.checkBash('demo', 'sid2', 'git commit -m x', root).ok, true);
});
