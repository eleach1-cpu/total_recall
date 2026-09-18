'use strict';
const fs = require('node:fs');

const TEXT = [
  ['user', 'let us work on the Tax Math Calculator today'],
  ['assistant', 'Reading the calculator first. It lives in src/tax-math.js and uses tax-math-core.'],
  ['user', 'the invoice total result looks off by one percent'],
  ['assistant', 'The rounding happens before the invoice add. I propose rounding after it.'],
  ['user', 'approved, do it'],
  ['assistant', 'Done. Rounding now happens after the invoice total is added.'],
  ['user', 'here is the api key for later sk-abcdefghijklmnopqrstuvwxyz123456 keep it private'],
  ['assistant', 'I will not store that. Use an env file.'],
  ['user', 'Never ship the invoice total rounding change again, it broke three orders.'],
  ['assistant', 'Understood, the invoice rounding stays as it is.'],
  ['user', 'what about the refund calculator, is it still in pilot'],
  ['assistant', 'The refund calculator is public since August 27; the flag file reverts it to pilot.'],
];

function rec(type, content, i, sid, day, extra = {}) {
  const ts = new Date(`${day}T10:${String(i).padStart(2, '0')}:00.000Z`).toISOString();
  return JSON.stringify({
    parentUuid: null, isSidechain: false, type,
    message: { role: type, content },
    uuid: `u-${i}`, timestamp: ts, sessionId: sid, cwd: 'C:\\proj', version: '2.1.260', gitBranch: 'master', ...extra,
  });
}

function makeSession(outFile, opts = {}) {
  const sid = opts.sessionId || 'fix-session-1';
  const day = opts.day || '2026-09-10';
  const lines = [];
  let i = 0;
  for (const [role, text] of TEXT) lines.push(rec(role, text, i++, sid, day));
  lines.push(rec('assistant', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/tax-math.js', old_string: 'a', new_string: 'b' } }], i++, sid, day));
  lines.push(rec('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'The file src/tax-math.js has been updated' }], i++, sid, day));
  lines.push(rec('assistant', [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'node --test tests/', description: 'run tests' } }], i++, sid, day));
  lines.push(rec('user', [{ type: 'tool_result', tool_use_id: 't2', content: 'pass 12 fail 0' }], i++, sid, day));
  lines.push(rec('assistant', [{ type: 'text', text: 'subagent chatter that must not be stored' }], i++, sid, day, { isSidechain: true }));
  lines.push(rec('user', 'Summary of the conversation so far: the invoice rounding was moved after the add and then frozen by owner directive.', i++, sid, day, { isCompactSummary: true }));
  fs.writeFileSync(outFile, lines.join('\n') + '\n');
  return { records: lines.length, turns: TEXT.length };
}

module.exports = { makeSession, TEXT };
