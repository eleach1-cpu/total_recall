'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-store-'));
  return openStore(path.join(dir, 'p.sqlite'));
}
const turn = (over) => ({ project: 'p', kind: 'turn', session_id: 's1', ts: '2026-09-18T10:00:00.000Z', role: 'user', title: 't', body: 'b', ...over });

test('insertDoc is idempotent by sha and reports it', () => {
  const s = fresh();
  const a = s.insertDoc(turn({ body: 'hello tax math' }));
  const b = s.insertDoc(turn({ body: 'hello tax math' }));
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  assert.equal(a.id, b.id);
  s.close();
});

test('search ranks a title hit above a body hit and honours kind and status filters', () => {
  const s = fresh();
  s.insertDoc(turn({ title: 'tax math calculator', body: 'nothing else' }));
  s.insertDoc(turn({ title: 'other', body: 'tax math in the body', ts: '2026-09-18T10:01:00.000Z' }));
  s.insertDoc({ project: 'p', kind: 'statement', ts: '2026-09-18T10:02:00.000Z', title: 'tax math stays', body: 'tax math stays', who: 'owner', outcome: 'standing', quote: 'q' });
  const all = s.search('"tax" OR "math"', { kinds: ['turn'], limit: 10 });
  assert.equal(all.length, 2);
  assert.equal(all[0].title, 'tax math calculator');
  const st = s.search('"tax"', { kinds: ['statement'], outcomes: ['standing'], who: 'owner', limit: 10 });
  assert.equal(st.length, 1);
  s.close();
});

test('supersedePath hides rows from search and linkSupersession points at the same-title replacement', () => {
  const s = fresh();
  const old = s.insertDoc({ project: 'p', kind: 'memory', ts: '2026-08-01T00:00:00.000Z', path: '/m/a.md', title: 'Rule A', body: 'old wording alpha' });
  assert.equal(s.supersedePath('/m/a.md'), 1);
  const neu = s.insertDoc({ project: 'p', kind: 'memory', ts: '2026-09-01T00:00:00.000Z', path: '/m/a.md', title: 'Rule A', body: 'new wording alpha' });
  assert.equal(s.linkSupersession('/m/a.md'), 1);
  assert.equal(s.getDoc(old.id).superseded_by, neu.id);
  assert.equal(s.search('"alpha"', { kinds: ['memory'], limit: 10 }).length, 1);
  assert.equal(s.search('"alpha"', { kinds: ['memory'], includeSuperseded: true, limit: 10 }).length, 2);
  s.close();
});

test('neighbours, session listing, sources and runs', () => {
  const s = fresh();
  const a = s.insertDoc(turn({ body: 'one', ts: '2026-09-18T10:00:00.000Z' }));
  const b = s.insertDoc(turn({ body: 'two', ts: '2026-09-18T10:01:00.000Z', role: 'assistant' }));
  const c = s.insertDoc(turn({ body: 'three', ts: '2026-09-18T10:02:00.000Z' }));
  s.insertDoc(turn({ body: 'other session', session_id: 's2', ts: '2026-09-19T10:00:00.000Z' }));
  const n = s.neighbours(b.id);
  assert.equal(n.prev.id, a.id);
  assert.equal(n.next.id, c.id);
  assert.deepEqual(s.recentSessionIds(5), ['s2', 's1']);
  assert.equal(s.turnsForSession('s1').length, 3);
  s.setSource({ path: '/t/s1.jsonl', kind: 'transcript', size: 10, mtime: 'm', sha: 'h', offset: 10, ingested_at: 'now' });
  assert.equal(s.getSource('/t/s1.jsonl').offset, 10);
  const key = { session_id: 's1', turn_from: a.id, turn_to: c.id, model: 'm', prompt_sha: 'p' };
  assert.equal(s.hasRun(key), false);
  s.insertRun({ ...key, ran_at: 'now', lines: 0 });
  assert.equal(s.hasRun(key), true);
  assert.deepEqual([...s.sessionsWithRuns()], ['s1']);
  const raw = s.recentUndistilledTurns('"other"', '2026-09-01T00:00:00.000Z', 5, s.sessionsWithRuns());
  assert.equal(raw.length, 1);
  assert.equal(raw[0].session_id, 's2');
  s.close();
});

test('dedupeStatements keeps the newest statement per session, cited turn and outcome', () => {
  const s = fresh();
  const t = s.insertDoc(turn({ body: 'never do that again' }));
  const a = s.insertDoc({ project: 'p', kind: 'statement', session_id: 's1', ts: '2026-09-18T10:00:00.000Z', title: 'Never do that (first wording)', body: 'x', who: 'owner', outcome: 'standing', quote: 'never do that again', evidence_ids: JSON.stringify([t.id]) });
  const b = s.insertDoc({ project: 'p', kind: 'statement', session_id: 's1', ts: '2026-09-18T10:00:00.000Z', title: 'Never do that (second wording)', body: 'y', who: 'owner', outcome: 'standing', quote: 'never do that again', evidence_ids: JSON.stringify([t.id]) });
  const other = s.insertDoc({ project: 'p', kind: 'statement', session_id: 's1', ts: '2026-09-18T10:00:00.000Z', title: 'Same turn, different outcome', body: 'z', who: 'owner', outcome: 'rejected', quote: 'never do that again', evidence_ids: JSON.stringify([t.id]) });
  assert.equal(s.dedupeStatements(), 1);
  assert.equal(s.getDoc(a.id).status, 'superseded');
  assert.equal(s.getDoc(a.id).superseded_by, b.id);
  assert.equal(s.getDoc(b.id).status, 'active');
  assert.equal(s.getDoc(other.id).status, 'active');
  assert.equal(s.dedupeStatements(), 0, 'idempotent');
  s.close();
});
