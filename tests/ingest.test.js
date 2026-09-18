'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');
const ingest = require('../lib/ingest');
const { makeSession } = require('./fixtures/make-session');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-ingest-'));
  const transcripts = path.join(root, 'transcripts');
  const notes = path.join(root, 'notes');
  const memory = path.join(root, 'memory');
  fs.mkdirSync(transcripts); fs.mkdirSync(notes); fs.mkdirSync(memory);
  makeSession(path.join(transcripts, 'fix-session-1.jsonl'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'handoff-v1.md'), path.join(notes, 'SESSION-HANDOFF-2026-09-10.md'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'memory-feedback.md'), path.join(memory, 'feedback_logo.md'));
  const cfg = {
    project: 'demo', root, transcripts,
    sources: { handoff: path.join(notes, 'SESSION-HANDOFF-*.md'), memory: path.join(memory, '*.md') },
    store: path.join(root, 'store.sqlite'),
  };
  return { root, cfg, transcripts, notes, store: openStore(cfg.store) };
}

test('transcript ingest keeps text turns, tool-only turns with files, compact summaries; drops sidechain and tool results; scrubs', () => {
  const { cfg, store } = setup();
  const r = ingest.run(cfg, { mode: 'new' }, store);
  assert.equal(r.turns, 12 + 1 + 1); // 12 text, 1 tool-only turn that touched a file (the Bash-only one names no file and is dropped), 1 compact summary
  const turns = store.turnsForSession('fix-session-1');
  assert.equal(turns.length, 13); // kind = turn only; the compact summary is its own kind
  assert.ok(!turns.some((t) => /subagent chatter/.test(t.body)));
  assert.ok(!turns.some((t) => /pass 12 fail 0/.test(t.body)));
  const keyTurn = turns.find((t) => /api key for later/.test(t.body));
  assert.match(keyTurn.body, /\[scrubbed\]/);
  assert.doesNotMatch(keyTurn.body, /sk-abc/);
  const edit = turns.find((t) => JSON.parse(t.files_json).includes('src/tax-math.js'));
  assert.ok(edit, 'edit turn carries its file');
  assert.deepEqual(JSON.parse(edit.tools_json), ['Edit']);
  const cs = store.search('"invoice"', { kinds: ['compact_summary'], limit: 5 });
  assert.equal(cs.length, 1);
  store.close();
});

test('second run adds nothing; appended records ingest exactly; truncation re-reads and supersedes', () => {
  const { cfg, store, transcripts } = setup();
  ingest.run(cfg, { mode: 'new' }, store);
  const again = ingest.run(cfg, { mode: 'new' }, store);
  assert.equal(again.turns, 0);
  const file = path.join(transcripts, 'fix-session-1.jsonl');
  const extra = [1, 2, 3].map((i) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: `late note ${i}` }, timestamp: `2026-09-10T11:0${i}:00.000Z`, sessionId: 'fix-session-1' })).join('\n') + '\n';
  fs.appendFileSync(file, extra);
  assert.equal(ingest.run(cfg, { mode: 'new' }, store).turns, 3);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'rewritten from zero' }, timestamp: '2026-09-10T12:00:00.000Z', sessionId: 'fix-session-1' }) + '\n');
  const r = ingest.run(cfg, { mode: 'new' }, store);
  assert.equal(r.turns, 1);
  assert.ok(r.superseded >= 16);
  assert.equal(store.turnsForSession('fix-session-1').length, 1);
  store.close();
});

test('markdown sections, feedback memory becomes a standing statement, edited handoff supersedes its section', () => {
  const { cfg, store, notes } = setup();
  const r = ingest.run(cfg, { mode: 'new' }, store);
  assert.equal(r.sections, 2 + 1);   // two handoff sections + one memory doc
  assert.equal(r.standing, 1);
  const st = store.standing(10);
  assert.equal(st.length, 1);
  assert.equal(st[0].who, 'owner');
  assert.match(st[0].title, /text-only logo/);
  assert.match(st[0].quote, /Never ship a text-only logo/);
  const shipped = store.search('"abc123"', { kinds: ['handoff'], limit: 5 });
  assert.equal(shipped.length, 1);
  assert.equal(shipped[0].ts.slice(0, 10), '2026-09-10');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'handoff-v2.md'), path.join(notes, 'SESSION-HANDOFF-2026-09-10.md'));
  const r2 = ingest.run(cfg, { mode: 'new' }, store);
  // Was 2: the edit superseded BOTH sections and the word-for-word identical "Open" one never came
  // back (same sha, so it was not re-inserted either), which dropped it from every search.
  assert.equal(r2.superseded, 1);
  assert.equal(store.search('refund', { kinds: ['handoff'], limit: 5 }).length, 1, 'the untouched section is still searchable');
  const after = store.search('"abc123"', { kinds: ['handoff'], limit: 5 });
  assert.equal(after.length, 1);
  assert.match(after[0].body, /guard test/);
  const old = store.search('"abc123"', { kinds: ['handoff'], includeSuperseded: true, limit: 5 }).find((d) => d.status === 'superseded');
  assert.equal(old.superseded_by, after[0].id);
  store.close();
});

test('selectors: range filters by ts and leaves offsets alone; session selects one file', () => {
  const { cfg, store } = setup();
  const r = ingest.run(cfg, { mode: 'range', since: '2026-09-11', to: '2026-09-12' }, store);
  assert.equal(r.turns, 0);
  assert.equal(store.getSource(path.join(cfg.transcripts, 'fix-session-1.jsonl')), undefined);
  const s = ingest.run(cfg, { mode: 'session', session: 'fix-session-1' }, store);
  assert.equal(s.turns, 14);
  assert.deepEqual(ingest.parseSelector({ all: true }), { mode: 'all' });
  assert.deepEqual(ingest.parseSelector({ since: '2026-09-01' }), { mode: 'range', since: '2026-09-01', to: undefined });
  assert.deepEqual(ingest.parseSelector({ from: '2026-09-01', to: '2026-09-02' }), { mode: 'range', since: '2026-09-01', to: '2026-09-02' });
  assert.deepEqual(ingest.parseSelector({}), { mode: 'new' });
  store.close();
});
