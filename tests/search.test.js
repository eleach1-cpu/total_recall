'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.TOTAL_RECALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-search-home-'));
const { openStore } = require('../lib/store');
const ingest = require('../lib/ingest');
const search = require('../lib/search');
const gate = require('../lib/gate');
const { makeSession } = require('./fixtures/make-session');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-search-'));
  const transcripts = path.join(root, 'transcripts'); fs.mkdirSync(transcripts);
  const today = new Date().toISOString().slice(0, 10);
  makeSession(path.join(transcripts, 'fix-session-1.jsonl'), { day: today });
  const cfg = { project: 'demo', root, transcripts, sources: {}, store: path.join(root, 's.sqlite'), search: { rawRecentDays: 7, rawRecentLimit: 5 } };
  const store = openStore(cfg.store);
  ingest.run(cfg, { mode: 'new' }, store);
  return { cfg, store };
}

test('buildMatch quotes tokens, keeps phrases, OR-joins', () => {
  assert.equal(search.buildMatch('tax math "invoice total"'), '"tax" OR "math" OR "invoice total"');
  assert.equal(search.buildMatch('  '), null);
});

test('an undistilled recent session surfaces under RAW; a distilled one does not', () => {
  const { cfg, store } = setup();
  const r = search.runSearch(store, cfg, { query: 'invoice rounding' });
  assert.equal(r.distilled.length, 1); // the compact summary
  assert.ok(r.raw.length >= 1, 'raw fallback present');
  assert.match(search.format(r, { query: 'invoice rounding' }), /RAW, not yet distilled/);
  const t = store.turnsForSession('fix-session-1');
  store.insertRun({ session_id: 'fix-session-1', turn_from: t[0].id, turn_to: t[t.length - 1].id, model: 'm', prompt_sha: 'p', ran_at: 'now', lines: 0 });
  const r2 = search.runSearch(store, cfg, { query: 'invoice rounding' });
  assert.equal(r2.raw.length, 0);
  store.close();
});

test('--deep follows evidence to the turn and its neighbours; --files and --kind filter', () => {
  const { cfg, store } = setup();
  const t = store.turnsForSession('fix-session-1');
  const owner = t.find((x) => /Never ship the invoice/.test(x.body));
  store.insertDoc({ project: 'demo', kind: 'statement', session_id: 'fix-session-1', ts: owner.ts, title: 'Invoice rounding change must never ship again', body: 'Invoice rounding change must never ship again\nquote', who: 'owner', outcome: 'standing', quote: 'Never ship the invoice total rounding change again', evidence_ids: JSON.stringify([owner.id]) });
  const r = search.runSearch(store, cfg, { query: 'invoice', deep: true, kinds: ['statement'] });
  assert.equal(r.distilled.length, 1);
  assert.equal(r.deepBlocks.length, 1);
  const ids = r.deepBlocks[0].turns.map((x) => x.id);
  assert.ok(ids.includes(owner.id));
  assert.equal(ids.length, 3);
  const out = search.format(r, { query: 'invoice', deep: true });
  assert.match(out, /owner standing/);
  assert.match(out, /quote: "Never ship/);
  const rawOut = search.format(search.runSearch(store, cfg, { query: 'invoice', kinds: ['turn'] }), { query: 'invoice' });
  assert.match(rawOut, /#\d+ turn \S+ \S+ \[owner\]/, 'raw hits name the speaker');
  assert.match(rawOut, /\[claude\]/);
  const byFile = search.runSearch(store, cfg, { query: 'tool-only', kinds: ['turn'], files: 'src/*.js' });
  assert.equal(byFile.distilled.length, 1);
  store.close();
});

test('--oldest and --newest order by date, need every word, skip tool-only turns; --until bounds a whole day or month', () => {
  const { cfg, store } = setup();
  const mk = (ts, body, role = 'user') => store.insertDoc({ project: 'demo', kind: 'turn', session_id: 's-dates', ts, role, title: body.slice(0, 60), body });
  mk('2026-07-02T10:00:00.000Z', 'first talk about the zebra lookup page');
  mk('2026-08-15T10:00:00.000Z', 'zebra lookup redesign');
  mk('2026-08-31T23:59:00.000Z', 'zebra lookup shipped');
  mk('2026-06-01T10:00:00.000Z', '(tool-only turn: Edit) public/zebra-lookup.html', 'assistant');
  mk('2026-06-15T10:00:00.000Z', 'zebra only, the second word is missing');
  const days = (o) => search.runSearch(store, cfg, { query: 'zebra lookup', kinds: ['turn'], ...o }).distilled.map((d) => d.ts.slice(0, 10));
  assert.deepEqual(days({ order: 'oldest' }), ['2026-07-02', '2026-08-15', '2026-08-31']);
  assert.deepEqual(days({ order: 'newest' }), ['2026-08-31', '2026-08-15', '2026-07-02']);
  assert.deepEqual(days({ order: 'oldest', since: '2026-08', until: '2026-08' }), ['2026-08-15', '2026-08-31']);
  assert.deepEqual(days({ order: 'oldest', until: '2026-08-15' }), ['2026-07-02', '2026-08-15']);
  assert.equal(days({ order: 'oldest', tools: true })[0], '2026-06-01', '--tools brings the tool-only turns back');
  assert.equal(search.buildMatch('tax math', ' AND '), '"tax" AND "math"');
  assert.equal(search.isDate('2026-08'), true);
  assert.equal(search.isDate('last week'), false);
  store.close();
});

test('a search opens the gate for the session it was given', () => {
  const { cfg, store } = setup();
  assert.equal(gate.isOpen('demo', 'sid-x'), false);
  search.runSearch(store, cfg, { query: 'tax math' }, 'sid-x');
  assert.equal(gate.isOpen('demo', 'sid-x'), true);
  store.close();
});
