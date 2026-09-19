'use strict';
// All evidence is synthetic and all stores are in memory. The optional root lets a reviewer
// run these identical tests against the unpatched copy without changing that copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = process.env.TOTAL_RECALL_TEST_ROOT || path.join(__dirname, '..');
const { openStore } = require(path.join(root, 'lib/store'));
const decide = require(path.join(root, 'lib/decide'));
const distill = require(path.join(root, 'lib/distill'));
const DAY = '2026-09-10';
const NOW = `${DAY}T12:00:00.000Z`;
const cfg = { project: 'demo', ollama: { chunkTokens: 6000, model: 'unused' }, distill: { provider: 'claude', model: 'claude-sonnet-5' } };
function turn(s, session, role, body, time, client = 'claude') {
  return s.insertDoc({ project: 'demo', kind: 'turn', session_id: session,
    source_client: client, origin: 'direct', ts: `${DAY}T${time}.000Z`, role,
    who: role === 'user' ? 'owner' : client, title: 'Synthetic turn', body }).id;
}
const record = (s, input) => decide.record(s, cfg, { client: 'claude', outcome: 'approved', now: NOW, ...input });

test('safety: identical context in two conversations is pending, not the newest match', () => {
  const s = openStore(':memory:');
  try {
    for (const [sid, a, b] of [['codex:task-a', '10:00:00', '10:01:00'], ['codex:task-b', '10:02:00', '10:03:00']]) {
      turn(s, sid, 'assistant', 'I can export the ledger as CSV. I suggest CSV.', a, 'codex');
      turn(s, sid, 'user', 'approved, do it', b, 'codex');
    }
    const input = { client: 'codex', statement: 'Owner approved exporting the ledger as CSV',
      scope: 'ledger export', quote: 'approved, do it', contextQuote: 'I suggest CSV' };
    const ambiguous = record(s, input);
    assert.equal(ambiguous.status, 'pending');
    assert.deepEqual(ambiguous.evidence, []);
    assert.equal(s.getDoc(ambiguous.id).session_id, null);
    assert.match(ambiguous.why, /2 exchanges match/);
    // A newer unrelated turn is not grounds to mark the ambiguous record unverified.
    turn(s, 'codex:other-task', 'user', 'The other task is finished.', '12:20:00', 'codex');
    decide.linkPending(s);
    assert.equal(s.getDoc(ambiguous.id).status, 'pending');
    // Same wording and summary in distinct KNOWN conversations must not collide by hash.
    const a = record(s, { ...input, session: 'codex:task-a' });
    const b = record(s, { ...input, session: 'codex:task-b' });
    assert.deepEqual([a.status, b.status], ['active', 'active']);
    assert.notEqual(a.id, b.id);
    assert.equal(s.getDoc(a.id).session_id, 'codex:task-a');
    assert.equal(s.getDoc(b.id).session_id, 'codex:task-b');
  } finally { s.close(); }
});

test('safety: repeated matching exchanges inside one known conversation are also ambiguous', () => {
  const s = openStore(':memory:');
  try {
    turn(s, 'repeat', 'assistant', 'I suggest exporting the ledger as CSV.', '10:00:00');
    turn(s, 'repeat', 'user', 'approved, do it', '10:01:00');
    turn(s, 'repeat', 'assistant', 'I suggest exporting the ledger as CSV.', '10:02:00');
    turn(s, 'repeat', 'user', 'approved, do it', '10:03:00');
    const r = record(s, { session: 'repeat', statement: 'Owner approved exporting the ledger as CSV',
      scope: 'ledger export', quote: 'approved, do it', contextQuote: 'exporting the ledger as CSV' });
    assert.equal(r.status, 'pending');
    assert.deepEqual(r.evidence, []);
  } finally { s.close(); }
});

test('safety: compatible rules remain standing until an explicit owner replacement names the old id', () => {
  const s = openStore(':memory:');
  try {
    turn(s, 'policy', 'user', 'Never publish reports without approval.', '10:00:00');
    const old = record(s, { session: 'policy', outcome: 'standing',
      statement: 'Reports require approval before publication', scope: 'publishing reports',
      quote: 'Never publish reports without approval.' });
    const instruction = 'Never publish reports containing personal details.';
    turn(s, 'policy', 'user', instruction, '10:10:00');
    const proposed = record(s, { session: 'policy', outcome: 'standing',
      statement: 'Reports must not contain personal details', scope: 'publishing reports',
      quote: instruction, replaces: old.id });
    assert.equal(proposed.relation.type, 'conflict');
    assert.equal(s.getDoc(old.id).superseded_by, null);
    assert.ok(s.standing(100).some(d => d.id === old.id));
    assert.ok(s.standing(100).some(d => d.id === proposed.id));

    // Text in the assistant-written statement is never confirmation by the owner.
    const wrongId = `Replace decision #999999 with: ${instruction}`;
    turn(s, 'policy', 'user', wrongId, '10:20:00');
    const wrong = record(s, { session: 'policy', outcome: 'standing',
      statement: `Owner confirmed replacement of decision #${old.id}`, scope: 'publishing reports',
      quote: wrongId, replaces: old.id });
    assert.equal(wrong.relation.type, 'conflict');
    assert.equal(s.getDoc(old.id).superseded_by, null);

    const confirmed = `Replace decision #${old.id} with: ${instruction}`;
    turn(s, 'policy', 'user', confirmed, '10:30:00');
    const replacement = record(s, { session: 'policy', outcome: 'standing',
      statement: 'Reports must not contain personal details', scope: 'publishing reports',
      quote: confirmed, replaces: old.id });
    assert.equal(replacement.relation.type, 'replaces');
    assert.equal(s.getDoc(old.id).superseded_by, replacement.id);
    assert.equal(s.getDoc(old.id).status, 'active', 'the earlier record is preserved');
    s.removeRelations(old.id);
    assert.equal(s.getDoc(old.id).superseded_by, null, 'the link is reversible');
  } finally { s.close(); }
});

test('safety: one changed subject is a different decision despite more than 80 percent overlap', () => {
  const s = openStore(':memory:');
  try {
    turn(s, 'colors', 'assistant', 'Which colors should we use on the website?', '10:00:00');
    const header = 'Make the website header background blue.';
    const footer = 'Make the website footer background blue.';
    const owner = turn(s, 'colors', 'user', `${header} ${footer}`, '10:01:00');
    const base = { session: 'colors', scope: 'website colors' };
    const a = record(s, { ...base, quote: header, statement: 'Owner chose blue for the header background' });
    const b = record(s, { ...base, quote: footer, statement: 'Owner chose blue for the footer background' });
    assert.deepEqual([s.getDoc(a.id).status, s.getDoc(b.id).status], ['active', 'active']);
    assert.equal(s.getDoc(a.id).superseded_by, null);
    assert.equal(s.statementTwin('colors', owner, 'approved', 'Make the website header background blue.').id, a.id);
    assert.equal(s.statementTwin('colors', owner, 'approved', 'Make the website header background blue'), null, 'containment is not equality');
    assert.equal(s.statementTwin('colors', owner, 'approved', ''), null, 'a missing quote is not a wildcard');
    assert.equal(record(s, { ...base, quote: header, statement: 'Owner chose blue for the header background' }).duplicate, true);
  } finally { s.close(); }
});

test('safety: the strong-reader path also preserves similar distinct quotes and does not recharge a completed slice', async () => {
  const s = openStore(':memory:');
  const previousFetch = global.fetch, previousKey = process.env.ANTHROPIC_API_KEY;
  try {
    turn(s, 'colors', 'assistant', 'Which colors should we use on the website?', '10:00:00');
    const quotes = ['Make the website header background blue.', 'Make the website footer background blue.'];
    const owner = turn(s, 'colors', 'user', quotes.join(' '), '10:01:00');
    let calls = 0;
    process.env.ANTHROPIC_API_KEY = 'synthetic-local-stub';
    global.fetch = async () => {
      calls++;
      return { ok: true, json: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 100 },
        content: [{ type: 'text', text: JSON.stringify({ items: quotes.map((quote, i) => ({ turn: owner, outcome: 'approved',
          statement: `Owner chose blue for the ${i ? 'footer' : 'header'} background`, quote, scope: 'website colors', certainty: 'clear' })) }) }] }) };
    };
    await distill.run(cfg, { mode: 'session', session: 'colors' }, { kind: 'decisions' }, s);
    await distill.run(cfg, { mode: 'session', session: 'colors' }, { kind: 'decisions' }, s);
    assert.equal(calls, 1);
    assert.deepEqual(s.distilledStatements().map(d => d.quote).sort(), [...quotes].sort());
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousKey;
    s.close();
  }
});
