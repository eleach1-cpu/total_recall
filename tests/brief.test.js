'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../lib/store');
const brief = require('../lib/brief');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-brief-'));
  const store = openStore(path.join(root, 's.sqlite'));
  const cfg = { project: 'demo', root, brief: { sessions: 3, maxLines: 40, standingLines: 15 } };
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const turn = (sid, n) => store.insertDoc({ project: 'demo', kind: 'turn', session_id: sid, ts: day(n), role: 'user', title: 't', body: `turn ${sid}` });
  for (let s = 1; s <= 5; s++) turn(`s${s}`, s);
  const st = (sid, n, over) => store.insertDoc({ project: 'demo', kind: 'statement', session_id: sid, ts: day(n), title: over.title, body: over.title, who: over.who || 'owner', outcome: over.outcome, quote: 'q', files_json: over.files || '[]' });
  st('s1', 1, { title: 'Recent decision', outcome: 'approved' });
  st('s1', 1, { title: 'Still open item', outcome: 'open' });
  st('s2', 2, { title: 'Touched the calculator', outcome: 'completed', files: JSON.stringify(['src/tax-math.js']) });
  st('s5', 5, { title: 'Too old to show', outcome: 'approved' });
  st('s5', 40, { title: 'Ancient standing rule', outcome: 'standing' });
  for (let i = 0; i < 20; i++) st('s1', 1, { title: `Standing rule ${i}`, outcome: 'standing' });
  return { store, cfg };
}

test('standing rules never age out and are capped with a pointer; open and file-matched lines rank first', () => {
  const { store, cfg } = setup();
  const lines = brief.buildBrief(store, cfg, new Set(['src/tax-math.js']));
  const text = lines.join('\n');
  assert.ok(lines.length <= 40);
  assert.equal(lines.filter((l) => / RULE /.test(l)).length, 15);
  assert.match(text, /\+6 more: total_recall search --outcome standing/);
  assert.doesNotMatch(text, /Too old to show/);
  const work = lines.filter((l) => /(open|approved|completed):/.test(l));
  assert.match(work[0], /Still open item|Touched the calculator/);
  assert.match(work[1], /Still open item|Touched the calculator/);
  assert.match(lines[lines.length - 1], /Run: total_recall search/);
  store.close();
});

test('the ancient standing rule is present when the cap is not exceeded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-brief-'));
  const store = openStore(path.join(root, 's.sqlite'));
  const cfg = { project: 'demo', root, brief: { sessions: 3, maxLines: 40, standingLines: 15 } };
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString();
  store.insertDoc({ project: 'demo', kind: 'turn', session_id: 's1', ts: day(1), role: 'user', title: 't', body: 'turn' });
  store.insertDoc({ project: 'demo', kind: 'statement', session_id: 's9', ts: day(40), title: 'Ancient standing rule', body: 'x', who: 'owner', outcome: 'standing', quote: 'q' });
  const text = brief.buildBrief(store, cfg, new Set()).join('\n');
  assert.match(text, /RULE owner: Ancient standing rule/);
  store.close();
});

test('empty store gives a one-line brief', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-brief-'));
  const store = openStore(path.join(root, 's.sqlite'));
  const lines = brief.buildBrief(store, { project: 'demo', root, brief: { sessions: 3, maxLines: 40, standingLines: 15 } }, new Set());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /empty/);
  store.close();
});
